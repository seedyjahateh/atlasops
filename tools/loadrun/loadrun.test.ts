/**
 * Load-run tests (P15b).
 *
 * The harness itself is not exercised here — it ingests a corpus and answers hundreds of requests,
 * which is a command rather than a test. What is tested is everything that decides what the numbers
 * *mean*: the pool that makes a stated concurrency true, the split that keeps a cache hit from
 * being reported as an answer, the rows that say why they could not be measured, and the check that
 * fails a build on a breached budget.
 *
 * Every one of these protects against a report that looks fine. A budget row silently omitted, a
 * p95 over eight samples presented as a percentile, a cache-lookup latency inside a three-second
 * answer budget — none of them fails anything, and all of them are wrong.
 */

import { describe, expect, it } from "vitest";

import {
  LOCAL_RERANKER,
  parseWorkload,
  RERANKER_BYPASSED,
  requestCost,
  runPool,
  workloadHash,
  type LoadRunResult,
  type RequestSample,
} from "./harness.js";
import { breachesIn, recordOf, unmeasuredIn } from "./measure.js";
import { renderLoadReport } from "./render.js";

const PROFILE = {
  id: "test-profile",
  corpusSnapshot: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  workload: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  models: {
    embedder: "stand-in-embedder",
    generator: "stand-in-not-a-model",
    reranker: "stand-in-reranker",
  },
  hardware: "test harness",
  concurrency: 2,
} as unknown as LoadRunResult["profile"];

function sample(overrides: Partial<RequestSample> = {}): RequestSample {
  return {
    index: 0,
    principal: "prn_reader",
    totalMs: 10,
    cacheHit: false,
    abstained: false,
    stages: [
      { stage: "permission-resolution", inclusiveMs: 1, selfMs: 1, count: 1 },
      { stage: "dense-retrieval", inclusiveMs: 4, selfMs: 4, count: 1 },
      { stage: "verification", inclusiveMs: 2, selfMs: 2, count: 1 },
    ],
    costUsd: null,
    retrievalCostUsd: null,
    inputTokens: 10,
    outputTokens: 5,
    ...overrides,
  };
}

function result(
  samples: readonly RequestSample[],
  cacheHits = 0,
  ingestionCostUsd: number | null = null,
): LoadRunResult {
  return {
    profile: PROFILE,
    samples,
    startedAt: "2026-09-24T00:00:00.000Z",
    finishedAt: "2026-09-24T00:01:00.000Z",
    chunksIngested: 35,
    ingestionEmbeddingTokens: 4200,
    ingestionCostUsd,
    priceTableVersion: "test-synthetic-1",
    retrievalCacheHits: cacheHits,
  };
}

describe("a stated concurrency is the one the run held", () => {
  it("never exceeds the pool size", async () => {
    // `Promise.all` over the schedule would put everything in flight at once: a spike of N rather
    // than a sustained level of C, whose p95 is a queueing artefact rather than a latency.
    let inFlight = 0;
    let peak = 0;

    await runPool(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );

    expect(peak).toBe(3);
  });

  it("runs every item exactly once", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, (item) => {
      seen.push(item);
      return Promise.resolve();
    });

    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a concurrency below one rather than running serially in silence", async () => {
    await expect(runPool([1], 0, () => Promise.resolve())).rejects.toThrow(/positive integer/);
  });
});

describe("the workload", () => {
  it("hashes by content, so a changed query changes the profile", () => {
    const one = parseWorkload({ id: "w", queries: [{ principal: "prn_a", query: "x" }] }, "w");
    const two = parseWorkload({ id: "w", queries: [{ principal: "prn_a", query: "y" }] }, "w");

    expect(workloadHash(one)).not.toBe(workloadHash(two));
  });

  it("refuses an empty workload", () => {
    // A p95 over nothing is NaN, and NaN compares as a pass against every budget.
    expect(() => parseWorkload({ queries: [] }, "w")).toThrow(/non-empty/);
  });

  it("refuses a query with no principal", () => {
    expect(() => parseWorkload({ queries: [{ query: "x" }] }, "w")).toThrow(/principal/);
  });
});

describe("the record", () => {
  it("separates cache hits from cache misses", () => {
    // The first run of this harness put 247 of 260 requests through the cache and reported the
    // result as an answer latency, inside a 3,000 ms budget.
    const record = recordOf(
      result([sample({ totalMs: 50 }), sample({ index: 1, totalMs: 1, cacheHit: true })], 1),
      null,
    );

    const stages = record.latency.map((row) => row.stage);
    expect(stages).toContain("end-to-end (retrieval cache miss)");
    expect(stages).toContain("end-to-end (retrieval cache hit)");
    expect(record.retrievalCacheHitRate).toBe(0.5);
  });

  it("caveats the end-to-end budget when the cache served most of the run", () => {
    const record = recordOf(
      result(
        Array.from({ length: 10 }, (_, index) =>
          sample({ index, cacheHit: index > 1, totalMs: index > 1 ? 1 : 40 }),
        ),
        8,
      ),
      null,
    );

    const row = record.budgets.find((entry) => entry.id === "ANSWER-LATENCY-P95");
    expect(row?.caveat).toMatch(/cache lookup rather than of an answer/);
  });

  it("does not caveat a run the cache did not dominate", () => {
    const record = recordOf(result([sample(), sample({ index: 1 })], 0), null);
    const row = record.budgets.find((entry) => entry.id === "ANSWER-LATENCY-P95");

    expect(row?.caveat).toBeNull();
  });

  it("marks a p95 that rests on twenty samples or fewer as the maximum it is", () => {
    const record = recordOf(result([sample(), sample({ index: 1 })], 0), null);
    const endToEnd = record.latency.find((row) => row.stage === "end-to-end");

    expect(endToEnd?.p95IsMaximum).toBe(true);
  });

  it("keeps every budget, measured or not", () => {
    // A report that dropped the rows it could not fill would read as a clean sheet.
    const record = recordOf(result([sample()], 0), null);

    expect(record.budgets).toHaveLength(10);
    const unmeasured = unmeasuredIn(record).map((row) => row.id);
    expect(unmeasured).toContain("TIME-TO-FIRST-TOKEN-P95");
    expect(unmeasured).toContain("COST-PER-ANSWER-P50");
  });

  it("says why each unmeasured budget could not be measured", () => {
    const record = recordOf(result([sample()], 0), null);

    for (const row of unmeasuredIn(record)) {
      expect(row.unmeasured, row.id).toMatch(/ADR|streaming|no span/);
    }
  });

  it("reports a stage with no spans as unmeasured rather than as zero", () => {
    // Zero is a real number that passes every budget. "No span" is the truth and fails nothing.
    const record = recordOf(result([sample({ stages: [] })], 0), null);
    const rerank = record.budgets.find((row) => row.id === "RERANK-STAGE-P95");

    expect(rerank?.value).toBeNull();
    expect(rerank?.unmeasured).toMatch(/no span/);
  });
});

describe("cost, when every model call is priced (P18a)", () => {
  // Synthetic costs, in round numbers, so nobody reads them as measurements.
  const priced = [
    sample({ index: 0, costUsd: 0.001, retrievalCostUsd: 0.0001 }),
    sample({ index: 1, costUsd: 0.002, retrievalCostUsd: 0.0001 }),
    sample({ index: 2, costUsd: 0.003, retrievalCostUsd: 0.0001 }),
    sample({ index: 3, costUsd: 0.0001, retrievalCostUsd: 0.0001, abstained: true }),
  ];

  it("measures cost per answer at the percentile each budget names", () => {
    // p50 and p95 are different budgets. The first version took p95 of everything, which would
    // have reported the tail under the name of the median.
    const record = recordOf(result(priced), null);
    const p50 = record.budgets.find((row) => row.id === "COST-PER-ANSWER-P50");
    const p95 = record.budgets.find((row) => row.id === "COST-PER-ANSWER-P95");

    expect(p50?.value).toBe(0.002);
    expect(p95?.value).toBe(0.003);
  });

  it("prices answered queries only", () => {
    // "Per answered query": the abstention's cheaper cost must not pull the figure down.
    const record = recordOf(result(priced), null);
    expect(record.budgets.find((row) => row.id === "COST-PER-ANSWER-P50")?.sampleSize).toBe(3);
  });

  it("says every cost figure excludes the unselected reranker, when a run used it", () => {
    const record = recordOf(result(priced), null);
    for (const id of ["COST-PER-ANSWER-P50", "COST-PER-ANSWER-P95", "RETRIEVAL-ONLY-COST"]) {
      expect(record.budgets.find((row) => row.id === id)?.caveat, id).toMatch(/excludes reranking/);
    }
  });

  describe("when the served configuration bypasses reranking (ADR 0011)", () => {
    const bypassed = (samples: readonly RequestSample[]): LoadRunResult => ({
      ...result(samples),
      profile: {
        ...PROFILE,
        models: { ...PROFILE.models, reranker: RERANKER_BYPASSED },
      },
    });

    it("claims no reranking exclusion, because nothing was excluded", () => {
      const record = recordOf(bypassed(priced), null);
      for (const id of ["COST-PER-ANSWER-P50", "COST-PER-ANSWER-P95", "RETRIEVAL-ONLY-COST"]) {
        expect(record.budgets.find((row) => row.id === id)?.caveat ?? "", id).not.toMatch(
          /excludes reranking/,
        );
      }
    });

    it("reports the rerank budget unmeasured because there is no stage, not because a span is missing", () => {
      const row = recordOf(bypassed(priced), null).budgets.find(
        (entry) => entry.id === "RERANK-STAGE-P95",
      );
      expect(row?.value).toBeNull();
      expect(row?.unmeasured).toMatch(/bypasses reranking \(ADR 0011\)/);
    });
  });

  it("reports ingestion cost per thousand chunks from the embedder's own token count", () => {
    const record = recordOf(result(priced, 0, 0.0035), null);
    const row = record.budgets.find((entry) => entry.id === "INGESTION-COST-PER-1K-CHUNKS");

    // 0.0035 over 35 chunks is 0.0001 per chunk, 0.1 per thousand.
    expect(row?.value).toBeCloseTo(0.1, 10);
    expect(row?.caveat).toMatch(/4200 embedding tokens/);
  });

  it("stays unmeasured if any answered query was unpriced", () => {
    // A total over the priced ones would be a real number describing part of the run.
    const mixed = [...priced, sample({ index: 4, costUsd: null })];
    const row = recordOf(result(mixed), null).budgets.find(
      (entry) => entry.id === "COST-PER-ANSWER-P50",
    );
    expect(row?.value).toBeNull();
    expect(row?.unmeasured).toMatch(/ADR 0002/);
  });
});

describe("a request's cost includes every model call it made (P18a)", () => {
  function trace(spans: readonly { modelId: string; cost: number | null }[]) {
    return {
      requestId: "req_x",
      totalMs: 1,
      degraded: false,
      spans: spans.map((span, id) => ({
        id,
        parentId: null,
        stage: "dense-retrieval" as const,
        startedAt: 0,
        endedAt: 1,
        durationMs: 1,
        degraded: false,
        model: {
          modelId: span.modelId,
          cacheHit: false,
          retries: 0,
          cost:
            span.cost === null
              ? null
              : {
                  modelId: span.modelId,
                  inputTokens: 1,
                  outputTokens: 0,
                  amountUsd: span.cost,
                  priceTableVersion: "t",
                },
        },
      })),
    } as unknown as Parameters<typeof requestCost>[0];
  }

  it("adds the query embedding to the generation", () => {
    // Until P18a the embedding span recorded no model call, so this total was generation alone.
    const cost = requestCost(trace([{ modelId: "text-embedding-3-small", cost: 0.0001 }]), 0.002);
    expect(cost.total).toBeCloseTo(0.0021, 10);
    expect(cost.retrieval).toBeCloseTo(0.0001, 10);
  });

  it("lets the local stand-in reranker through, by name only", () => {
    const cost = requestCost(
      trace([
        { modelId: "text-embedding-3-small", cost: 0.0001 },
        { modelId: LOCAL_RERANKER, cost: null },
      ]),
      0.002,
    );
    expect(cost.total).toBeCloseTo(0.0021, 10);
  });

  it("is unknown when any other call is unpriced", () => {
    const cost = requestCost(trace([{ modelId: "some-unpriced-embedder", cost: null }]), 0.002);
    expect(cost.total).toBeNull();
  });

  it("is unknown when generation is unpriced", () => {
    const cost = requestCost(trace([{ modelId: "text-embedding-3-small", cost: 0.0001 }]), null);
    expect(cost.total).toBeNull();
  });
});

describe("breaches", () => {
  it("finds a budget the run exceeded", () => {
    const record = recordOf(result([sample({ totalMs: 9000 })], 0), null);
    const breaches = breachesIn(record);

    expect(breaches.map((breach) => breach.id)).toContain("ANSWER-LATENCY-P95");
  });

  it("does not count an unmeasured budget as a breach", () => {
    // Nor as a pass. It is neither, and treating it as either is the mistake.
    const record = recordOf(result([sample()], 0), null);
    expect(breachesIn(record)).toEqual([]);
  });
});

describe("the rendered report", () => {
  const record = recordOf(
    result([sample({ totalMs: 40 }), sample({ index: 1, totalMs: 1, cacheHit: true })], 1),
    "abc123",
  );
  const rendered = renderLoadReport(record);

  it("names the price table every cost came from (PRD 12 item 4)", () => {
    expect(record.priceTableVersion).toBe("test-synthetic-1");
    expect(rendered).toContain("**Price table:** test-synthetic-1");
  });

  it("states the profile a reader would need to reproduce it", () => {
    expect(rendered).toContain("test-profile");
    expect(rendered).toContain(PROFILE.corpusSnapshot);
    expect(rendered).toContain("**Commit:** abc123");
    expect(rendered).toContain("stand-in-embedder");
  });

  it("lists the budgets it could not measure, with the reason", () => {
    expect(rendered).toContain("Why the rest could not be measured");
    expect(rendered).toContain("TIME-TO-FIRST-TOKEN-P95");
  });

  it("says no request left the machine", () => {
    // The sentence that stops this artefact being read as a latency claim about a deployment.
    expect(rendered).toContain("No request left this machine");
  });

  it("says the cost rows are unmeasurable rather than zero", () => {
    expect(rendered).toContain("**No cost figure is produced**");
  });

  it("states that PRD 12 item 4 remains unmet", () => {
    expect(rendered).toContain("remains unmet");
  });
});
