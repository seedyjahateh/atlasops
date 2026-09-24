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
  parseWorkload,
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
  models: { embedder: "stand-in-embedder", generator: "stand-in-not-a-model" },
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
    inputTokens: 10,
    outputTokens: 5,
    ...overrides,
  };
}

function result(samples: readonly RequestSample[], cacheHits = 0): LoadRunResult {
  return {
    profile: PROFILE,
    samples,
    startedAt: "2026-09-24T00:00:00.000Z",
    finishedAt: "2026-09-24T00:01:00.000Z",
    chunksIngested: 35,
    ingestionEmbeddingTokens: 35,
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
