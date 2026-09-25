/**
 * OpenAI adapter tests.
 *
 * **Nothing here touches the network**, and that is enforced rather than promised: every test
 * drives `recordingTransport`, and `fetchTransport` refuses to run under the test runner at all, so
 * an adapter accidentally constructed without a transport fails loudly instead of spending money.
 *
 * What is worth testing in an adapter is not "it parses a response" but the handful of ways a
 * provider can hand back something plausible and wrong: vectors in a different order than the texts
 * that produced them, a batch that came back short, a response with no usage, an answer truncated
 * mid-sentence. Each of those is silent in production — a mispaired embedding retrieves confidently
 * wrong passages — so each has a test that asserts the adapter stops.
 *
 * The one thing recorded responses cannot prove is that the wire shape matches today's API. That is
 * what `pnpm smoke:openai` is for: one real call, run deliberately, never in CI.
 */

import { AtlasOpsError } from "@atlasops/contracts";
import { costOf } from "@atlasops/telemetry";
import { describe, expect, it } from "vitest";

import { isModelError, ModelError } from "./errors.js";
import { createEmbeddingGateway } from "./gateway.js";
import {
  failureKindFor,
  failureKindForStatus,
  openAiEmbedder,
  openAiGenerator,
  openAiKeyFromEnv,
  redactKey,
  retryAfterMsOf,
  OPENAI_BASE_URL,
} from "./openai.js";
import { UNSELECTED_RERANKER, openAiModelSet, parseModelChoice } from "./model-set.js";
import {
  OPENAI_DEFAULT_EMBEDDING_DIMENSION,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  OPENAI_DEFAULT_GENERATION_MODEL,
  OPENAI_PRICE_TABLE,
} from "./prices-openai.js";
import { recordingSleeper } from "./retry.js";
import { recordingTransport, type RecordedExchange } from "./transport.js";

const KEY = "sk-test-not-a-real-key-000000";

/** Two dimensions, so a fixture vector is readable. The real default is 1536. */
const DIMENSION = 2;

function embeddingBody(vectors: readonly (readonly [number, number])[], promptTokens = 7): string {
  return JSON.stringify({
    object: "list",
    model: OPENAI_DEFAULT_EMBEDDING_MODEL,
    data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  });
}

function chatBody(content: string, input = 11, output = 5, finishReason = "stop"): string {
  return JSON.stringify({
    id: "chatcmpl-x",
    model: OPENAI_DEFAULT_GENERATION_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  });
}

/**
 * A streamed chat completion, as server-sent events: an opening event that only announces the
 * role, one event per content piece, a finish event, the usage event `include_usage` asks for, and
 * the terminator.
 */
function sseEvents(
  pieces: readonly string[],
  options: { input?: number; output?: number; finish?: string | null; usage?: boolean } = {},
): string[] {
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const base = {
    id: "chatcmpl-x",
    object: "chat.completion.chunk",
    model: "gpt-4.1-mini-2025-04-14",
  };
  const events = [
    event({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
    ...pieces.map((content) =>
      event({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
    ),
  ];
  if (options.finish !== null) {
    events.push(
      event({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: options.finish ?? "stop" }],
      }),
    );
  }
  if (options.usage !== false) {
    const input = options.input ?? 11;
    const output = options.output ?? 5;
    events.push(
      event({
        ...base,
        choices: [],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      }),
    );
  }
  events.push("data: [DONE]\n\n");
  return events;
}

/** A clock that advances by `step` on every read, so each timing is a known number. */
function steppingClock(step: number) {
  let at = 0;
  return {
    now: (): number => {
      at += step;
      return at;
    },
  };
}

function streamingGenerator(
  exchanges: readonly (RecordedExchange | Error)[],
  clock = steppingClock(10),
) {
  const transport = recordingTransport(exchanges);
  return {
    transport,
    generator: openAiGenerator({
      apiKey: KEY,
      model: OPENAI_DEFAULT_GENERATION_MODEL,
      transport,
      stream: true,
      clock,
    }),
  };
}

function embedder(exchanges: readonly (RecordedExchange | Error)[]) {
  const transport = recordingTransport(exchanges);
  return {
    transport,
    embedder: openAiEmbedder({
      apiKey: KEY,
      model: OPENAI_DEFAULT_EMBEDDING_MODEL,
      dimension: DIMENSION,
      transport,
    }),
  };
}

function generator(exchanges: readonly (RecordedExchange | Error)[]) {
  const transport = recordingTransport(exchanges);
  return {
    transport,
    generator: openAiGenerator({
      apiKey: KEY,
      model: OPENAI_DEFAULT_GENERATION_MODEL,
      transport,
    }),
  };
}

describe("the key", () => {
  it("comes from the environment and says which variable when it is missing", () => {
    expect(() => openAiKeyFromEnv({})).toThrow(AtlasOpsError);
    expect(() => openAiKeyFromEnv({ OPENAI_API_KEY: "   " })).toThrow(/OPENAI_API_KEY is not set/);
  });

  it("is trimmed, because a trailing newline from a shell is not part of the key", () => {
    expect(openAiKeyFromEnv({ OPENAI_API_KEY: `${KEY}\n` })).toBe(KEY);
  });

  it("never appears in text that leaves the adapter", () => {
    // Providers do echo keys back in error bodies, and the body is the thing an adapter is most
    // tempted to attach to an exception.
    const body = `Incorrect API key provided: ${KEY}. You can find your key at ...`;
    const redacted = redactKey(body, KEY);
    expect(redacted).not.toContain(KEY);
    expect(redacted).toContain("[redacted]");
  });

  it("redacts a key-shaped string even when it is not the configured key", () => {
    expect(redactKey("leaked sk-abcdefghijklmnop here", "")).toBe("leaked [redacted] here");
  });
});

describe("embedding", () => {
  it("sends the model, the batch and the dimension to the embeddings endpoint", async () => {
    const { transport, embedder: subject } = embedder([
      { status: 200, body: embeddingBody([[1, 0]]) },
    ]);

    await subject.embed({ texts: ["hello"] });

    const [request] = transport.sent();
    expect(request?.url).toBe(`${OPENAI_BASE_URL}/embeddings`);
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      model: OPENAI_DEFAULT_EMBEDDING_MODEL,
      input: ["hello"],
      dimensions: DIMENSION,
    });
  });

  it("orders vectors by the index field, not by array position", async () => {
    // The API documents them as the same. Relying on that pairs vectors with the wrong text if it
    // ever stops being true, and a mispaired embedding is invisible: it retrieves plausible,
    // confidently wrong passages rather than failing.
    const body = JSON.stringify({
      model: OPENAI_DEFAULT_EMBEDDING_MODEL,
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
      usage: { prompt_tokens: 4 },
    });
    const { embedder: subject } = embedder([{ status: 200, body }]);

    const result = await subject.embed({ texts: ["first", "second"] });
    expect(result.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("reports input tokens and no output tokens", async () => {
    const { embedder: subject } = embedder([{ status: 200, body: embeddingBody([[1, 0]], 9) }]);
    const result = await subject.embed({ texts: ["hello"] });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 0 });
  });

  it("makes no call at all for an empty batch", async () => {
    const { transport, embedder: subject } = embedder([]);
    const result = await subject.embed({ texts: [] });

    expect(transport.sent()).toHaveLength(0);
    expect(result.vectors).toEqual([]);
  });

  it("refuses a batch that came back short", async () => {
    const { embedder: subject } = embedder([{ status: 200, body: embeddingBody([[1, 0]]) }]);
    await expect(subject.embed({ texts: ["a", "b"] })).rejects.toThrow(/asked for 2 embeddings/);
  });

  it("refuses a vector of the wrong width", async () => {
    const body = JSON.stringify({
      data: [{ index: 0, embedding: [1, 0, 0] }],
      usage: { prompt_tokens: 1 },
    });
    const { embedder: subject } = embedder([{ status: 200, body }]);
    await expect(subject.embed({ texts: ["a"] })).rejects.toThrow(/expected 2 dimensions/);
  });

  it("refuses a response with no usage rather than assuming zero tokens", async () => {
    // Zero input tokens is a real number that prices to zero. PRD 9.2 wants cost attributable per
    // request, so a call whose usage is missing has to stop rather than report a free one.
    const body = JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] });
    const { embedder: subject } = embedder([{ status: 200, body }]);
    await expect(subject.embed({ texts: ["a"] })).rejects.toThrow(/no token usage/);
  });

  it("gives the same refusal when usage is present but has no token count", async () => {
    // The caller's problem is identical, so the message is too — a reader chasing it should not
    // have to know which shape the provider sent.
    const body = JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }], usage: {} });
    const { embedder: subject } = embedder([{ status: 200, body }]);
    await expect(subject.embed({ texts: ["a"] })).rejects.toThrow(/no token usage/);
  });
});

describe("generation", () => {
  it("keeps the instruction block and the user turn separate", async () => {
    const { transport, generator: subject } = generator([{ status: 200, body: chatBody("ok") }]);

    await subject.generate({ system: "instructions", user: "question" });

    const payload = JSON.parse(transport.sent()[0]?.body ?? "{}") as {
      messages: { role: string; content: string }[];
      temperature: number;
    };
    expect(payload.messages).toEqual([
      { role: "system", content: "instructions" },
      { role: "user", content: "question" },
    ]);
    expect(payload.temperature).toBe(0);
  });

  it("returns the text and both token counts", async () => {
    const { generator: subject } = generator([{ status: 200, body: chatBody("an answer", 11, 5) }]);
    const result = await subject.generate({ system: "s", user: "u" });

    expect(result.text).toBe("an answer");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
  });

  it("treats a truncated answer as a failure, not a short answer", async () => {
    // Verification in PRD 7.2 parses the answer structure. A response cut mid-citation fails there
    // with a confusing message about malformed output; failing here says what happened.
    const { generator: subject } = generator([
      { status: 200, body: chatBody("half of an ans", 11, 5, "length") },
    ]);
    await expect(subject.generate({ system: "s", user: "u" })).rejects.toThrow(/output limit/);
  });

  it("refuses a response with no choices", async () => {
    const { generator: subject } = generator([
      { status: 200, body: JSON.stringify({ choices: [] }) },
    ]);
    await expect(subject.generate({ system: "s", user: "u" })).rejects.toThrow(/no choices/);
  });

  it("refuses a 200 whose body is not JSON", async () => {
    const { generator: subject } = generator([{ status: 200, body: "<html>gateway</html>" }]);
    await expect(subject.generate({ system: "s", user: "u" })).rejects.toThrow(/not valid JSON/);
  });
});

describe("failures are classified so the existing retry loop keeps working", () => {
  it("maps status codes to kinds", () => {
    expect(failureKindForStatus(429)).toBe("rate-limited");
    expect(failureKindForStatus(503)).toBe("unavailable");
    expect(failureKindForStatus(504)).toBe("timeout");
    expect(failureKindForStatus(400)).toBe("invalid-request");
    // A bad key is a configuration error a person must fix. Retrying it only delays the moment
    // somebody reads the message, and degrading past it would serve without the model.
    expect(failureKindForStatus(401)).toBe("invalid-request");
  });

  it("raises a ModelError carrying the capability that failed", async () => {
    const { embedder: subject } = embedder([{ status: 429, body: "slow down" }]);

    await expect(subject.embed({ texts: ["a"] })).rejects.toSatisfy(
      (error: unknown) =>
        isModelError(error) && error.capability === "embedding" && error.retryable,
    );
  });

  it("never puts the key into the error it raises", async () => {
    const { embedder: subject } = embedder([
      { status: 401, body: `Incorrect API key provided: ${KEY}` },
    ]);

    const error = await subject.embed({ texts: ["a"] }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).not.toContain(KEY);
  });

  it("retries a rate limit on the existing schedule and then succeeds", async () => {
    // The adapter is new; the retry loop is not. This asserts they compose — a 429 is classified
    // as retryable, the gateway waits 100 ms, and the second call returns.
    const transport = recordingTransport([
      { status: 429, body: "slow down" },
      { status: 200, body: embeddingBody([[1, 0]]) },
    ]);
    const sleeper = recordingSleeper();
    const gateway = createEmbeddingGateway(
      openAiEmbedder({
        apiKey: KEY,
        model: OPENAI_DEFAULT_EMBEDDING_MODEL,
        dimension: DIMENSION,
        transport,
      }),
      { sleeper },
    );

    const outcome = await gateway.embed(["hello"]);
    expect(outcome.attempts).toBe(2);
    expect(sleeper.delays()).toEqual([100]);
    expect(transport.sent()).toHaveLength(2);
  });

  it("does not retry an account with no credit, although it arrives as a 429", async () => {
    // The first live call this repository made got exactly this response. Read by status alone it
    // is a rate limit and gets retried three times with backoff; retrying cannot fix billing.
    const body = JSON.stringify({
      error: {
        message: "You have no credits remaining.",
        type: "insufficient_quota",
        code: "credit_balance_exhausted",
      },
    });
    expect(failureKindFor(429, body)).toBe("invalid-request");

    const transport = recordingTransport([{ status: 429, body }]);
    const gateway = createEmbeddingGateway(
      openAiEmbedder({
        apiKey: KEY,
        model: OPENAI_DEFAULT_EMBEDDING_MODEL,
        dimension: DIMENSION,
        transport,
      }),
      { sleeper: recordingSleeper() },
    );

    await expect(gateway.embed(["hello"])).rejects.toThrow(/insufficient_quota/);
    expect(transport.sent()).toHaveLength(1);
  });

  it("waits at least as long as the provider asks before retrying", async () => {
    // The first real load run was told "try again in 338ms" and waited 100 ms, then 200 ms, then
    // gave up. A backoff shorter than the requested wait fails every attempt by construction.
    const limited = {
      status: 429,
      body: '{"error":{"message":"Rate limit reached. Please try again in 338ms.","code":"rate_limit_exceeded"}}',
    };
    const transport = recordingTransport([limited, { status: 200, body: embeddingBody([[1, 0]]) }]);
    const sleeper = recordingSleeper();
    const gateway = createEmbeddingGateway(
      openAiEmbedder({
        apiKey: KEY,
        model: OPENAI_DEFAULT_EMBEDDING_MODEL,
        dimension: DIMENSION,
        transport,
      }),
      { sleeper },
    );

    await gateway.embed(["hello"]);
    expect(sleeper.delays()).toEqual([338]);
  });

  it("prefers the retry-after headers to the sentence in the body", () => {
    expect(retryAfterMsOf({ "retry-after-ms": "1250" }, "try again in 9s")).toBe(1250);
    expect(retryAfterMsOf({ "retry-after": "2" }, "")).toBe(2000);
    expect(retryAfterMsOf({}, "Please try again in 1.5s.")).toBe(1500);
    expect(retryAfterMsOf({}, "no hint at all")).toBeNull();
  });

  it("still retries a genuine rate limit", () => {
    expect(failureKindFor(429, '{"error":{"type":"requests","code":"rate_limit_exceeded"}}')).toBe(
      "rate-limited",
    );
  });

  it("does not retry a malformed request", async () => {
    const transport = recordingTransport([{ status: 400, body: "bad input" }]);
    const gateway = createEmbeddingGateway(
      openAiEmbedder({
        apiKey: KEY,
        model: OPENAI_DEFAULT_EMBEDDING_MODEL,
        dimension: DIMENSION,
        transport,
      }),
      { sleeper: recordingSleeper() },
    );

    await expect(gateway.embed(["hello"])).rejects.toThrow(ModelError);
    expect(transport.sent()).toHaveLength(1);
  });
});

describe("the recorded transport", () => {
  it("refuses to invent a reply it was not given", async () => {
    // A fake that repeats its last answer lets a test assert two calls when only one happened.
    const transport = recordingTransport([{ status: 200, body: "{}" }]);
    await transport.send({
      url: "u",
      method: "POST",
      headers: {},
      body: "{}",
      timeoutMs: 1,
    });
    await expect(
      transport.send({ url: "u", method: "POST", headers: {}, body: "{}", timeoutMs: 1 }),
    ).rejects.toThrow(/1 recorded exchange\(s\) and was called 2/);
  });
});

describe("choosing a model set (P18a)", () => {
  it("defaults to the stand-ins, so nothing spends money unless asked", () => {
    expect(parseModelChoice(undefined)).toBe("stand-in");
    expect(parseModelChoice("")).toBe("stand-in");
  });

  it("refuses a set this build does not have, naming the ones it does", () => {
    expect(() => parseModelChoice("anthropic")).toThrow(/Installed: stand-in, openai/);
  });

  it("refuses to build the OpenAI set without a key, naming the variable", () => {
    expect(() => openAiModelSet({})).toThrow(/OPENAI_API_KEY is not set/);
  });

  it("builds embedder and generator with the dated price table", () => {
    const set = openAiModelSet({ OPENAI_API_KEY: KEY }, { transport: recordingTransport([]) });

    expect(set.identifiers.embedder).toBe(OPENAI_DEFAULT_EMBEDDING_MODEL);
    expect(set.identifiers.generator).toBe(OPENAI_DEFAULT_GENERATION_MODEL);
    expect(set.prices).toBe(OPENAI_PRICE_TABLE);
    expect(set.embedding.dimension).toBe(OPENAI_DEFAULT_EMBEDDING_DIMENSION);
  });

  it("records the reranker as unselected rather than inventing one", () => {
    const set = openAiModelSet({ OPENAI_API_KEY: KEY }, { transport: recordingTransport([]) });
    expect(set.identifiers.reranker).toBe(UNSELECTED_RERANKER);
    expect(set.identifiers.reranker).toMatch(/unselected/);
  });

  it("asks the generator for JSON mode, so a code fence cannot fail every answer", async () => {
    const events = sseEvents(['{"abstain":true}']);
    const transport = recordingTransport([{ status: 200, body: events.join(""), chunks: events }]);
    const set = openAiModelSet({ OPENAI_API_KEY: KEY }, { transport });

    await set.generator.generate({ system: "Answer with a JSON object.", user: "q" });

    const payload = JSON.parse(transport.sent()[0]?.body ?? "{}") as {
      response_format?: { type: string };
    };
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("streams, so the time to first token is measured on every real run (PRD 9.3)", async () => {
    const events = sseEvents(['{"abstain":true}']);
    const transport = recordingTransport([{ status: 200, body: events.join(""), chunks: events }]);
    const set = openAiModelSet({ OPENAI_API_KEY: KEY }, { transport });

    const result = await set.generator.generate({ system: "s", user: "q" });

    const payload = JSON.parse(transport.sent()[0]?.body ?? "{}") as Record<string, unknown>;
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
  });
});

describe("streamed generation (PRD 9.3, ADR 0012)", () => {
  it("assembles the whole answer, and returns it once", async () => {
    const events = sseEvents(['{"segm', 'ents":[]', "}"], { input: 40, output: 9 });
    const { generator: g } = streamingGenerator([{ status: 200, body: "", chunks: events }]);

    const result = await g.generate({ system: "s", user: "q" });
    expect(result.text).toBe('{"segments":[]}');
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
    // The snapshot the provider served, as the non-streamed path reports it.
    expect(result.modelId).toBe("gpt-4.1-mini-2025-04-14");
  });

  it("frames events split anywhere, because the network splits them anywhere", async () => {
    const whole = sseEvents(['{"a":', "1}"]).join("");
    // Cut every seven characters: through keys, through `data:`, through the blank lines.
    const chunks = whole.match(/[\s\S]{1,7}/g) ?? [];
    const { generator: g } = streamingGenerator([{ status: 200, body: "", chunks }]);

    expect((await g.generate({ system: "s", user: "q" })).text).toBe('{"a":1}');
  });

  it("times the first token from the first content, not from the role announcement", async () => {
    // The stepping clock reads 10 at the start; the role-only event carries no content, so the
    // next read is at the first content event: 20 - 10 = 10.
    const events = sseEvents(["x", "y"]);
    const { generator: g } = streamingGenerator(
      [{ status: 200, body: "", chunks: events }],
      steppingClock(10),
    );

    const result = await g.generate({ system: "s", user: "q" });
    expect(result.firstTokenMs).toBe(10);
    expect(result.responseMs).toBeGreaterThan(result.firstTokenMs ?? 0);
  });

  it("refuses a stream that ends before the model finished", async () => {
    const events = sseEvents(["partial"], { finish: null });
    const { generator: g } = streamingGenerator([{ status: 200, body: "", chunks: events }]);
    await expect(g.generate({ system: "s", user: "q" })).rejects.toThrow(/ended before/);
  });

  it("reports an answer cut off at the output limit the same way the whole-response path does", async () => {
    const events = sseEvents(["long"], { finish: "length" });
    const { generator: g } = streamingGenerator([{ status: 200, body: "", chunks: events }]);
    await expect(g.generate({ system: "s", user: "q" })).rejects.toThrow(/output limit/);
  });

  it("refuses a stream without usage, which cannot be priced", async () => {
    const events = sseEvents(["x"], { usage: false });
    const { generator: g } = streamingGenerator([{ status: 200, body: "", chunks: events }]);
    await expect(g.generate({ system: "s", user: "q" })).rejects.toThrow(/cannot be priced/);
  });

  it("raises an error event in the stream as a model failure, with the key redacted", async () => {
    const chunks = [`data: ${JSON.stringify({ error: { message: `bad ${KEY}` } })}\n\n`];
    const { generator: g } = streamingGenerator([{ status: 200, body: "", chunks }]);
    const failure = await g.generate({ system: "s", user: "q" }).catch((error: unknown) => error);
    expect(isModelError(failure)).toBe(true);
    expect((failure as Error).message).not.toContain(KEY);
  });

  it("classifies a non-2xx streamed response exactly as a whole one, keeping the requested wait", async () => {
    const { generator: g } = streamingGenerator([
      {
        status: 429,
        body: '{"error":{"message":"Rate limit reached"}}',
        headers: { "retry-after-ms": "338" },
      },
    ]);
    const failure = await g.generate({ system: "s", user: "q" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelError);
    expect((failure as ModelError).kind).toBe("rate-limited");
    expect((failure as ModelError).retryAfterMs).toBe(338);
  });

  it("refuses to be built over a transport that cannot stream", () => {
    const whole = recordingTransport([]);
    const sendOnly = { send: whole.send };
    expect(() =>
      openAiGenerator({ apiKey: KEY, model: "m", transport: sendOnly, stream: true }),
    ).toThrow(/cannot stream/);
  });

  it("reports no first token for a whole response, rather than calling its latency one", async () => {
    const { generator: g } = generator([{ status: 200, body: chatBody("{}") }]);
    const result = await g.generate({ system: "s", user: "q" });
    expect(result.firstTokenMs).toBeUndefined();
  });
});

describe("the price table", () => {
  it("prices the models this build uses", () => {
    expect(OPENAI_PRICE_TABLE.models[OPENAI_DEFAULT_EMBEDDING_MODEL]).toBeDefined();
    expect(OPENAI_PRICE_TABLE.models[OPENAI_DEFAULT_GENERATION_MODEL]).toBeDefined();
    expect(OPENAI_DEFAULT_EMBEDDING_DIMENSION).toBe(1536);
  });

  it("carries a source and a date on every entry", () => {
    // ADR 0002's rule, now that the table is no longer empty: a price with no citation is a price
    // somebody remembered, and section 0 forbids that reaching a cost report.
    for (const [modelId, price] of Object.entries(OPENAI_PRICE_TABLE.models)) {
      expect(price.source, modelId).toMatch(/^https:\/\//);
      expect(price.retrievedOn, modelId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("names the date in its version, so a cost record can be re-derived", () => {
    expect(OPENAI_PRICE_TABLE.version).toMatch(/^openai-\d{4}-\d{2}-\d{2}$/);
    // The version is a literal so that a search finds it; this keeps the literal honest.
    for (const [modelId, price] of Object.entries(OPENAI_PRICE_TABLE.models)) {
      expect(OPENAI_PRICE_TABLE.version, modelId).toBe(`openai-${price.retrievedOn}`);
    }
  });

  it("computes a cost that a reader can check by hand", () => {
    // 1,000,000 input tokens of text-embedding-3-small at $0.02 per 1M is exactly $0.02.
    const cost = costOf(OPENAI_PRICE_TABLE, OPENAI_DEFAULT_EMBEDDING_MODEL, 1_000_000, 0);
    expect(cost.amountUsd).toBeCloseTo(0.02, 10);
    expect(cost.priceTableVersion).toBe(OPENAI_PRICE_TABLE.version);
  });

  it("still throws for a model it does not price", () => {
    expect(() => costOf(OPENAI_PRICE_TABLE, "some-unpriced-model", 10, 10)).toThrow(/no price/);
  });
});
