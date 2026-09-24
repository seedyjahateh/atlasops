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
  failureKindForStatus,
  openAiEmbedder,
  openAiGenerator,
  openAiKeyFromEnv,
  redactKey,
  OPENAI_BASE_URL,
} from "./openai.js";
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
