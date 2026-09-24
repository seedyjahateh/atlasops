/**
 * Model-gateway tests.
 *
 * Nothing here waits. The retry schedule is asserted from a `recordingSleeper` that resolves
 * immediately and keeps the delays it was asked for — which tests the thing that actually matters
 * (how long, how many times, which failures) in microseconds of wall time. A test that really slept
 * would prove none of that and would make the suite slow for the privilege.
 *
 * Nothing here calls a paid API either. That is the point of the layer.
 */

import { describe, expect, it } from "vitest";

import { inMemoryEmbeddingCache, embeddingCacheKey } from "./cache.js";
import { ModelError, isModelError } from "./errors.js";
import {
  countingEmbedder,
  deterministicVector,
  fakeEmbedder,
  fakeGenerator,
  fakeReranker,
  flakyEmbedder,
  unavailableGenerator,
  unavailableReranker,
} from "./fake.js";
import {
  createEmbeddingGateway,
  generateWithRetry,
  rerankWithRetry,
  toModelCall,
} from "./gateway.js";
import { DEFAULT_RETRY_POLICY, backoffFor, recordingSleeper, withRetry } from "./retry.js";
import { UNPRICED_TABLE, type PriceTable } from "@atlasops/telemetry";

const SYNTHETIC_PRICES: PriceTable = {
  version: "test-synthetic-1",
  currency: "USD",
  models: {
    "fake-embedder": {
      inputPer1MTokens: 100,
      outputPer1MTokens: 0,
      source: "synthetic: invented for this test, not a vendor price",
      retrievedOn: "2026-01-01",
    },
    "fake-generator": {
      inputPer1MTokens: 1000,
      outputPer1MTokens: 2000,
      source: "synthetic: invented for this test, not a vendor price",
      retrievedOn: "2026-01-01",
    },
  },
};

const FAST = { sleeper: recordingSleeper() };

describe("failures are classified by what the caller should do", () => {
  it("treats unavailability, rate limits and timeouts as retryable", () => {
    for (const kind of ["unavailable", "rate-limited", "timeout"] as const) {
      expect(new ModelError("embedder", kind, "x").retryable).toBe(true);
    }
  });

  it("does not retry an invalid request", () => {
    // Retrying a malformed prompt produces the same rejection more slowly and spends the
    // attempt budget on a call that cannot succeed.
    expect(new ModelError("generator", "invalid-request", "x").retryable).toBe(false);
  });

  it("names the capability that failed, so a degraded-mode switch need not parse a message", () => {
    const error = new ModelError("reranker", "unavailable", "down");
    expect(error.capability).toBe("reranker");
    expect(error.code).toBe("MODEL_UNAVAILABLE");
    expect(isModelError(error)).toBe(true);
  });
});

describe("the retry schedule, asserted without waiting", () => {
  it("backs off exponentially and caps", () => {
    const policy = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 500 };
    expect([1, 2, 3, 4].map((attempt) => backoffFor(policy, attempt))).toEqual([
      100, 200, 400, 500,
    ]);
  });

  it("asks for the exact delays it should, in order", async () => {
    const sleeper = recordingSleeper();
    const inner = flakyEmbedder(fakeEmbedder(), 2);
    const gateway = createEmbeddingGateway(inner, { sleeper });

    const outcome = await gateway.embed(["hello"]);

    expect(outcome.attempts).toBe(3);
    expect(sleeper.delays()).toEqual([100, 200]);
  });

  it("stops immediately on a non-retryable failure and sleeps not at all", async () => {
    const sleeper = recordingSleeper();
    const inner = flakyEmbedder(fakeEmbedder(), 1, "invalid-request");

    await expect(createEmbeddingGateway(inner, { sleeper }).embed(["hello"])).rejects.toThrow(
      ModelError,
    );
    expect(sleeper.delays()).toEqual([]);
  });

  it("gives up after the attempt budget and rethrows the last failure", async () => {
    const sleeper = recordingSleeper();
    const inner = flakyEmbedder(fakeEmbedder(), 99);

    await expect(createEmbeddingGateway(inner, { sleeper }).embed(["hello"])).rejects.toThrow(
      /transient fixture failure/,
    );
    // maxAttempts is 3, so two waits and then a rethrow rather than a fourth call.
    expect(sleeper.delays()).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts - 1);
  });

  it("never retries an error that is not a ModelError", async () => {
    // An unexpected exception is an adapter bug, not a transient condition. Repeating it three
    // times turns one stack trace into three and delays the report.
    const sleeper = recordingSleeper();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new TypeError("adapter bug"));
        },
        DEFAULT_RETRY_POLICY,
        sleeper,
      ),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });
});

describe("the deterministic fakes", () => {
  it("returns the same vector for the same text, every time and everywhere", () => {
    expect(deterministicVector("retention policy", 32)).toEqual(
      deterministicVector("retention policy", 32),
    );
  });

  it("returns different vectors for different text", () => {
    expect(deterministicVector("alpha", 32)).not.toEqual(deterministicVector("beta", 32));
  });

  it("produces unit vectors, so cosine similarity is a dot product", () => {
    const vector = deterministicVector("anything", 64);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("produces the requested dimension", () => {
    expect(deterministicVector("x", 1536)).toHaveLength(1536);
  });

  it("ranks a candidate sharing more query terms higher, and breaks ties stably", async () => {
    const result = await fakeReranker().rerank({
      query: "retention policy",
      candidates: [
        { id: "a", text: "unrelated text about weather" },
        { id: "b", text: "retention policy" },
        { id: "c", text: "policy" },
      ],
    });
    expect(result.scores[0]?.id).toBe("b");
    expect(result.scores.at(-1)?.id).toBe("a");
  });

  it("reports usage on every call so cost is attributable per request", async () => {
    const result = await fakeGenerator().generate({ system: "sys", user: "question" });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe("the embedding cache (PRD 4.2, 6.3)", () => {
  it("embeds only the texts that missed", async () => {
    const cache = inMemoryEmbeddingCache();
    const counting = countingEmbedder(fakeEmbedder());
    const gateway = createEmbeddingGateway(counting, { ...FAST, cache });

    await gateway.embed(["a", "b"]);
    const second = await gateway.embed(["a", "b", "c"]);

    // The second call sends one text, not three. This is the difference between PRD 4.2's chunk
    // reuse and a re-ingestion that costs the same as the first one.
    expect(counting.textsSeen()).toBe(3);
    expect(second.cacheHits).toBe(2);
    expect(second.vectors).toHaveLength(3);
  });

  it("returns cached vectors in the caller's original order", async () => {
    const cache = inMemoryEmbeddingCache();
    const gateway = createEmbeddingGateway(fakeEmbedder(), { ...FAST, cache });

    await gateway.embed(["b"]);
    const mixed = await gateway.embed(["a", "b", "c"]);

    expect(mixed.vectors[1]).toEqual(deterministicVector("b", 32));
    expect(mixed.vectors[0]).toEqual(deterministicVector("a", 32));
  });

  it("makes no call at all when everything is cached", async () => {
    const cache = inMemoryEmbeddingCache();
    const counting = countingEmbedder(fakeEmbedder());
    const gateway = createEmbeddingGateway(counting, { ...FAST, cache });

    await gateway.embed(["a"]);
    const outcome = await gateway.embed(["a"]);

    expect(counting.calls()).toBe(1);
    expect(outcome.attempts).toBe(0);
    expect(outcome.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("keys on the model, so changing model does not return the old model's vectors", () => {
    // Without this the fastest path in the system produces the mixed-model index PRD 4.4 calls
    // silently broken, without anyone running a migration.
    const a = embeddingCacheKey({ id: "model-a", dimension: 32 }, "same text");
    const b = embeddingCacheKey({ id: "model-b", dimension: 32 }, "same text");
    const c = embeddingCacheKey({ id: "model-a", dimension: 64 }, "same text");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("works with no cache configured", async () => {
    const outcome = await createEmbeddingGateway(fakeEmbedder(), FAST).embed(["a"]);
    expect(outcome.cacheHits).toBe(0);
    expect(outcome.vectors).toHaveLength(1);
  });
});

describe("degraded modes surface as typed failures (PRD 9.4)", () => {
  it("lets a caller see that the reranker specifically is gone", async () => {
    let capability = "";
    try {
      await rerankWithRetry(unavailableReranker(), { query: "q", candidates: [] }, FAST);
    } catch (error) {
      capability = (error as ModelError).capability;
    }
    // PRD 9.4: serve fused results with reranking bypassed. The caller branches on which
    // capability is missing, which is why that is a field rather than a message to parse.
    expect(capability).toBe("reranker");
  });

  it("lets a caller see that generation specifically is gone", async () => {
    let capability = "";
    try {
      await generateWithRetry(unavailableGenerator(), { system: "s", user: "u" }, FAST);
    } catch (error) {
      capability = (error as ModelError).capability;
    }
    expect(capability).toBe("generator");
  });
});

describe("the bridge to telemetry", () => {
  it("reports retries as attempts minus one, because the first call is not a retry", async () => {
    const sleeper = recordingSleeper();
    const gateway = createEmbeddingGateway(flakyEmbedder(fakeEmbedder(), 2), { sleeper });
    const outcome = await gateway.embed(["hello"]);

    const call = toModelCall({
      modelId: "fake-embedder",
      usage: outcome.usage,
      outcome,
      priceTable: SYNTHETIC_PRICES,
    });

    expect(call.retries).toBe(2);
    expect(call.cost?.priceTableVersion).toBe("test-synthetic-1");
  });

  it("records the call with a null cost when the table cannot price the model", async () => {
    // ADR 0002 says never report zero for an unpriced model. Throwing here would have meant a
    // stand-in could not be traced at all, so the stage went uninstrumented instead — which is
    // how PRD 9.3's generation and verification budgets ended up with nothing to aggregate.
    const gateway = createEmbeddingGateway(fakeEmbedder(), FAST);
    const outcome = await gateway.embed(["hello"]);

    const call = toModelCall({
      modelId: "unpriced-stand-in",
      usage: outcome.usage,
      outcome,
      priceTable: UNPRICED_TABLE,
    });

    expect(call.modelId).toBe("unpriced-stand-in");
    expect(call.cost).toBeNull();
  });

  it("floors retries at zero for a fully cached call", async () => {
    const cache = inMemoryEmbeddingCache();
    const gateway = createEmbeddingGateway(fakeEmbedder(), { ...FAST, cache });
    await gateway.embed(["a"]);
    const outcome = await gateway.embed(["a"]);

    const call = toModelCall({
      modelId: "fake-embedder",
      usage: outcome.usage,
      outcome,
      priceTable: SYNTHETIC_PRICES,
      totalTexts: 1,
    });

    expect(call.retries).toBe(0);
    expect(call.cacheHit).toBe(true);
    expect(call.cost?.amountUsd).toBe(0);
  });

  it("reports a partial cache hit as a miss when the total is known", async () => {
    // Two of three cached still means a model call happened, and a span that claims a cache hit
    // would make the hit-rate aggregate in PRD 9.2 overstate itself.
    const cache = inMemoryEmbeddingCache();
    const gateway = createEmbeddingGateway(fakeEmbedder(), { ...FAST, cache });
    await gateway.embed(["a", "b"]);
    const outcome = await gateway.embed(["a", "b", "c"]);

    const call = toModelCall({
      modelId: "fake-embedder",
      usage: outcome.usage,
      outcome,
      priceTable: SYNTHETIC_PRICES,
      totalTexts: 3,
    });

    expect(call.cacheHit).toBe(false);
  });
});
