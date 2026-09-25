/**
 * The OpenAI adapter: real embeddings, real generation, behind the ports that already existed.
 *
 * **Nothing above this file changes.** `openAiEmbedder` returns an `Embedder` and `openAiGenerator`
 * returns a `Generator`, so the pipeline cannot tell a real model from a stand-in except by the
 * model identifier it records — which is the point of having built the fakes first. Swapping in a
 * provider is a change confined to this directory, and P0–P12's tests keep running offline.
 *
 * **No SDK.** The adapter speaks the two REST endpoints it needs over the transport port. The
 * tradeoff is recorded in ADR 0006: no dependency to audit and a wire shape that tests can record
 * exactly, against writing the request shaping and the error mapping by hand — and, more seriously,
 * against losing the boundary rule that keys on SDK package names. Bare `fetch` would slip straight
 * past `provider-sdk-outside-gateway`, so that rule gained a sibling that keys on the endpoint host
 * instead, and both are enforced.
 *
 * **The key is read once, from the environment, and never travels.** It is not in a field anything
 * serialises, not in an error message, and not in a span. `redactKey` exists because a provider's
 * own error body sometimes quotes the key back, and the body is what an adapter is most tempted to
 * attach to an exception.
 */

import { AtlasOpsError, type EmbeddingModelRef } from "@atlasops/contracts";

import { ModelError, type ModelFailureKind } from "./errors.js";
import type {
  EmbedRequest,
  EmbedResult,
  Embedder,
  GenerateRequest,
  GenerateResult,
  Generator,
} from "./ports.js";
import {
  collectChunks,
  fetchTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "./transport.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** The default deadline for one call. Deliberately shorter than any budget in PRD 9.3. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenAiConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  /** Sent as `OpenAI-Organization` when present. Some accounts require it; most do not. */
  readonly organization?: string | undefined;
}

/**
 * Reads the key from the environment, or says exactly what is missing.
 *
 * Environment only. A key read from a file is a key that gets committed, and this repository is
 * public. The error names the variable and never echoes a partial value — "expected sk-… got sk-ab"
 * is a leak in a bug report.
 */
export function openAiKeyFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const key = env.OPENAI_API_KEY;
  if (key === undefined || key.trim().length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "OPENAI_API_KEY is not set. The adapter reads its key from the environment only — never " +
        "from a file in the repository — so set it in the shell that runs the command.",
      "OPENAI_API_KEY",
    );
  }
  return key.trim();
}

/** Removes anything key-shaped from provider text before it reaches an error or a log. */
export function redactKey(text: string, key: string): string {
  const withoutExact = key.length > 0 ? text.split(key).join("[redacted]") : text;
  return withoutExact.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

/**
 * HTTP status to failure kind.
 *
 * 429 and 5xx are worth repeating; a 400 is not, because the same malformed request produces the
 * same rejection more slowly. 401 is deliberately *not* retryable and not silently degraded: a bad
 * key is a configuration error a person must fix, and retrying it three times only delays the
 * moment somebody reads the message.
 */
export function failureKindForStatus(status: number): ModelFailureKind {
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  return "invalid-request";
}

/**
 * A 429 that is not a rate limit.
 *
 * OpenAI returns HTTP 429 for two different conditions: too many requests, which passes, and an
 * account with no credit, which does not. The first version of this adapter read the status alone,
 * so an empty balance was classified as a rate limit and retried three times with backoff — found
 * by the first live call this repository ever made, which was answered with exactly that. Retrying
 * cannot fix billing, and it delays the one message a person needs to read.
 */
const EXHAUSTED_QUOTA = ["insufficient_quota", "credit_balance_exhausted"];

export function failureKindFor(status: number, body: string): ModelFailureKind {
  if (status === 429 && EXHAUSTED_QUOTA.some((marker) => body.includes(marker))) {
    return "invalid-request";
  }
  return failureKindForStatus(status);
}

/**
 * How long the provider asked the caller to wait, in milliseconds, or null.
 *
 * The standard headers first — `retry-after-ms`, then `retry-after` in seconds. The body's own
 * "try again in 338ms" is read only when neither header is present: it is a human sentence, and
 * parsing prose is a fallback, never the first choice. Anything unparseable is null rather than a
 * guess, which leaves the ordinary backoff in charge.
 */
export function retryAfterMsOf(
  headers: Readonly<Record<string, string>>,
  body: string,
): number | null {
  const milliseconds = Number(headers["retry-after-ms"]);
  if (headers["retry-after-ms"] !== undefined && Number.isFinite(milliseconds)) return milliseconds;

  const seconds = Number(headers["retry-after"]);
  if (headers["retry-after"] !== undefined && Number.isFinite(seconds)) return seconds * 1000;

  const stated = /try again in ([0-9]+(?:\.[0-9]+)?)(ms|s)\b/.exec(body);
  if (stated?.[1] !== undefined) {
    const value = Number(stated[1]);
    return stated[2] === "s" ? value * 1000 : value;
  }

  return null;
}

interface CallInput {
  readonly capability: string;
  readonly path: string;
  readonly payload: unknown;
  readonly config: OpenAiConfig;
  readonly signal?: AbortSignal | undefined;
}

function requestFor(input: CallInput): HttpRequest {
  const { config } = input;
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };
  if (config.organization !== undefined) headers["openai-organization"] = config.organization;

  return {
    url: `${config.baseUrl ?? OPENAI_BASE_URL}${input.path}`,
    method: "POST",
    headers,
    body: JSON.stringify(input.payload),
    signal: input.signal,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** A non-2xx response as the failure it is, with the key redacted and the requested wait kept. */
function failureFor(
  capability: string,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>>,
  apiKey: string,
): ModelError {
  return new ModelError(
    capability,
    failureKindFor(status, body),
    `HTTP ${String(status)}: ${redactKey(body, apiKey).slice(0, 400)}`,
    retryAfterMsOf(headers, body),
  );
}

async function call(input: CallInput): Promise<unknown> {
  const { config } = input;
  const transport = config.transport ?? fetchTransport;

  const response: HttpResponse = await transport.send(requestFor(input));

  if (response.status < 200 || response.status >= 300) {
    throw failureFor(
      input.capability,
      response.status,
      response.body,
      response.headers,
      config.apiKey,
    );
  }

  try {
    return JSON.parse(response.body);
  } catch {
    // A 200 with a body that is not JSON is the provider misbehaving, not the caller.
    throw new ModelError(input.capability, "unavailable", "response body was not valid JSON");
  }
}

function record(value: unknown, capability: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelError(capability, "unavailable", `${what} was not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Token counts, or a refusal.
 *
 * Usage is not decorative: PRD 9.2 requires cost to be attributable per request, and a call whose
 * token count is missing cannot be priced. Defaulting to zero would put an invented number into the
 * cost table — and zero is the worst available guess, because it makes the call look free.
 *
 * The two ways it can be missing (no `usage` at all, or a `usage` without `prompt_tokens`) produce
 * the same message on purpose. The caller's problem is identical either way, and a reader chasing
 * "no token usage" should not have to know which shape the provider sent.
 */
function usageFrom(value: unknown, capability: string): { input: number; output: number } {
  const absent = (): never => {
    throw new ModelError(
      capability,
      "unavailable",
      "response carried no token usage, so the call cannot be priced",
    );
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) absent();
  const usage = value as Record<string, unknown>;

  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== "number") absent();

  return { input: input as number, output: typeof output === "number" ? output : 0 };
}

export interface OpenAiEmbedderConfig extends OpenAiConfig {
  readonly model: string;
  /** Sent as `dimensions`. The ref carries it too, so a mixed index is detectable (PRD 4.4). */
  readonly dimension: number;
}

export function openAiEmbedder(config: OpenAiEmbedderConfig): Embedder {
  const model: EmbeddingModelRef = { id: config.model, dimension: config.dimension };

  return {
    model,

    async embed(request: EmbedRequest): Promise<EmbedResult> {
      if (request.texts.length === 0) {
        // No call, no usage. A provider would reject an empty batch, and paying a round trip to
        // learn that is worse than answering it here.
        return { model, vectors: [], usage: { inputTokens: 0, outputTokens: 0 } };
      }

      const body = await call({
        capability: "embedding",
        path: "/embeddings",
        payload: { model: config.model, input: request.texts, dimensions: config.dimension },
        config,
        signal: request.signal,
      });

      const parsed = record(body, "embedding", "response");
      const data = parsed.data;
      if (!Array.isArray(data)) {
        throw new ModelError("embedding", "unavailable", "response carried no data array");
      }
      if (data.length !== request.texts.length) {
        throw new ModelError(
          "embedding",
          "unavailable",
          `asked for ${String(request.texts.length)} embeddings and received ${String(data.length)}`,
        );
      }

      // Ordering is by the `index` field, not by array position. The API documents them as the
      // same; relying on that silently pairs vectors with the wrong text if it ever stops being
      // true, and a mispaired embedding is invisible — it retrieves plausible wrong passages.
      const vectors = new Array<readonly number[] | undefined>(data.length);
      for (const entry of data) {
        const item = record(entry, "embedding", "data entry");
        const index = item.index;
        const vector = item.embedding;
        if (typeof index !== "number" || index < 0 || index >= data.length) {
          throw new ModelError("embedding", "unavailable", "data entry carried no usable index");
        }
        if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
          throw new ModelError("embedding", "unavailable", "data entry carried no numeric vector");
        }
        if (vector.length !== config.dimension) {
          throw new ModelError(
            "embedding",
            "unavailable",
            `expected ${String(config.dimension)} dimensions and received ${String(vector.length)}`,
          );
        }
        vectors[index] = vector as readonly number[];
      }

      if (vectors.some((vector) => vector === undefined)) {
        throw new ModelError("embedding", "unavailable", "response skipped an index");
      }

      const usage = usageFrom(parsed.usage, "embedding");
      return {
        model,
        vectors: vectors as readonly (readonly number[])[],
        usage: { inputTokens: usage.input, outputTokens: 0 },
      };
    },
  };
}

export interface OpenAiGeneratorConfig extends OpenAiConfig {
  readonly model: string;
  /** Zero by default: the answer contract in PRD 7.1 is a structure, not a style exercise. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * Ask the provider to return a JSON object and nothing else.
   *
   * Grounding's prompt already asks for JSON in words, and a model that honours the request but
   * wraps the object in a Markdown code fence produces text `JSON.parse` rejects — every answer then
   * fails verification for a formatting reason rather than a grounding one, which would make the
   * first real evaluation measure fences. JSON mode removes the fence without loosening the parser.
   */
  readonly jsonOutput?: boolean;
  /**
   * Read the answer as a stream, so the time to its first token can be measured (PRD 9.3).
   *
   * **The caller still receives the whole answer, once.** PRD 7.2 verifies an answer before it is
   * returned, and a token cannot be verified alone, so nothing here streams to a user. What
   * streaming buys is the measurement: how long the model took to start, distinct from how long
   * it took to finish. Requires a transport that can stream.
   */
  readonly stream?: boolean;
  /** Monotonic milliseconds for timing the stream. `performance.now()` unless a test supplies one. */
  readonly clock?: { readonly now: () => number };
}

/** The `data:` payloads of a server-sent event stream, framed from chunks that split anywhere. */
export async function* sseData(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line.startsWith("data:")) yield line.slice("data:".length).trimStart();
      end = buffer.indexOf("\n");
    }
  }
  const last = buffer.replace(/\r$/, "");
  if (last.startsWith("data:")) yield last.slice("data:".length).trimStart();
}

const OUTPUT_LIMIT =
  "the model hit its output limit before finishing; raise maxOutputTokens or shorten the prompt";

export function openAiGenerator(config: OpenAiGeneratorConfig): Generator {
  const transport = config.transport ?? fetchTransport;
  const streamed = transport.stream;
  if (config.stream === true && streamed === undefined) {
    // At construction, not at the first call: a load run that meant to measure time to first
    // token and silently measured nothing is the failure this prevents.
    throw new AtlasOpsError(
      "VALIDATION",
      "streaming was requested, but the transport cannot stream",
      "config.stream",
    );
  }
  const clock = config.clock ?? { now: (): number => performance.now() };

  const payloadFor = (request: GenerateRequest): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      model: config.model,
      temperature: config.temperature ?? 0,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    };
    if (config.maxOutputTokens !== undefined) {
      payload.max_completion_tokens = config.maxOutputTokens;
    }
    if (config.jsonOutput === true) {
      payload.response_format = { type: "json_object" };
    }
    return payload;
  };

  /**
   * The streamed read. Usage arrives in a final event with no choices, because the request asks
   * for it (`include_usage`); a stream that ends without it cannot be priced and is refused, the
   * same as a whole response without it. A stream that ends before a finish reason was cut off,
   * and a cut-off answer is not a shorter answer.
   */
  const generateStreamed = async (
    stream: NonNullable<HttpTransport["stream"]>,
    request: GenerateRequest,
  ): Promise<GenerateResult> => {
    const payload = {
      ...payloadFor(request),
      stream: true,
      stream_options: { include_usage: true },
    };
    const started = clock.now();
    const response = await stream(
      requestFor({
        capability: "generation",
        path: "/chat/completions",
        payload,
        config,
        signal: request.signal,
      }),
    );

    if (response.status < 200 || response.status >= 300) {
      const body = await collectChunks(response.chunks);
      throw failureFor("generation", response.status, body, response.headers, config.apiKey);
    }

    let text = "";
    let firstTokenMs: number | undefined;
    let finishReason: unknown;
    let usageRecord: unknown;
    let servedModel: string | undefined;

    for await (const data of sseData(response.chunks)) {
      if (data === "[DONE]") break;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        throw new ModelError("generation", "unavailable", "a stream event was not valid JSON");
      }
      const parsed = record(event, "generation", "stream event");
      if (parsed.error !== undefined) {
        throw new ModelError(
          "generation",
          "unavailable",
          `the stream reported an error: ${redactKey(JSON.stringify(parsed.error), config.apiKey).slice(0, 400)}`,
        );
      }
      if (typeof parsed.model === "string") servedModel = parsed.model;
      if (parsed.usage !== undefined && parsed.usage !== null) usageRecord = parsed.usage;

      const choices = parsed.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const first = record(choices[0], "generation", "choice");
        const delta = first.delta;
        const content =
          typeof delta === "object" && delta !== null
            ? (delta as Record<string, unknown>).content
            : undefined;
        if (typeof content === "string" && content.length > 0) {
          // The first token is the first *content*. An opening event that only announces the
          // assistant role carries none, and timing it would measure the connection.
          firstTokenMs ??= clock.now() - started;
          text += content;
        }
        if (typeof first.finish_reason === "string") finishReason = first.finish_reason;
      }
    }
    const responseMs = clock.now() - started;

    if (finishReason === "length") {
      throw new ModelError("generation", "invalid-request", OUTPUT_LIMIT);
    }
    if (finishReason === undefined) {
      throw new ModelError(
        "generation",
        "unavailable",
        "the stream ended before the model finished",
      );
    }

    const usage = usageFrom(usageRecord, "generation");
    return {
      modelId: servedModel ?? config.model,
      text,
      usage: { inputTokens: usage.input, outputTokens: usage.output },
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
      responseMs,
    };
  };

  return {
    modelId: config.model,

    async generate(request: GenerateRequest): Promise<GenerateResult> {
      if (config.stream === true && streamed !== undefined) {
        return generateStreamed(streamed, request);
      }
      const payload = payloadFor(request);

      const body = await call({
        capability: "generation",
        path: "/chat/completions",
        payload,
        config,
        signal: request.signal,
      });

      const parsed = record(body, "generation", "response");
      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new ModelError("generation", "unavailable", "response carried no choices");
      }

      const first = record(choices[0], "generation", "choice");
      const message = record(first.message, "generation", "message");
      const text = message.content;
      if (typeof text !== "string") {
        throw new ModelError("generation", "unavailable", "choice carried no text content");
      }

      // A truncated answer is not a shorter answer. Verification in PRD 7.2 parses the structure,
      // and a response cut mid-citation would fail there with a confusing message; failing here
      // says what actually happened.
      if (first.finish_reason === "length") {
        throw new ModelError("generation", "invalid-request", OUTPUT_LIMIT);
      }

      const usage = usageFrom(parsed.usage, "generation");
      return {
        modelId: typeof parsed.model === "string" ? parsed.model : config.model,
        text,
        usage: { inputTokens: usage.input, outputTokens: usage.output },
      };
    },
  };
}
