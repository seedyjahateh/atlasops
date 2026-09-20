/**
 * Telemetry tests.
 *
 * Every duration here is exact, because the clock is injected. Nothing sleeps: a suite that waits
 * for real milliseconds is slow and still only able to assert "greater than zero", which passes for
 * a stopwatch wired backwards.
 *
 * The price table used below is explicitly synthetic and named so. No test depends on a real vendor
 * price, because this repository does not hold any (ADR 0002).
 */

import { AtlasOpsError, contentHashOf, formatRequestId } from "@atlasops/contracts";
import { describe, expect, it } from "vitest";

import { BUDGETS, assertWithinBudget, budgetById, checkBudget } from "./budget.js";
import { manualClock } from "./clock.js";
import { percentile, percentileIsMaximumBelow } from "./percentile.js";
import { UNPRICED_TABLE, canPrice, costOf, totalCost, type PriceTable } from "./prices.js";
import { measure, type ReferenceProfile } from "./profile.js";
import {
  cacheHitRate,
  costByStage,
  createTrace,
  groupDuration,
  stageBreakdown,
  traceCost,
} from "./span.js";

/** Synthetic. Round numbers precisely so that no reader mistakes them for real pricing. */
const SYNTHETIC_PRICES: PriceTable = {
  version: "test-synthetic-1",
  currency: "USD",
  models: {
    "fake-generator": { inputPer1MTokens: 1000, outputPer1MTokens: 2000 },
    "fake-embedder": { inputPer1MTokens: 100, outputPer1MTokens: 0 },
  },
};

const PROFILE: ReferenceProfile = {
  id: "test-profile",
  corpusSnapshot: contentHashOf("corpus-snapshot-fixture"),
  workload: contentHashOf("workload-fixture"),
  models: { generator: "fake-generator", embedder: "fake-embedder" },
  hardware: "test harness, single process",
  concurrency: 1,
};

const REQUEST = formatRequestId("01k9z4m2nq");

describe("the clock is injected", () => {
  it("produces exact durations with no real waiting", () => {
    const clock = manualClock();
    const trace = createTrace(REQUEST, clock);
    const span = trace.span("fusion");
    clock.advance(37);
    span.end();
    expect(trace.finish().spans[0]?.durationMs).toBe(37);
  });

  it("refuses to move backwards, which a monotonic clock cannot do", () => {
    expect(() => {
      manualClock().advance(-1);
    }).toThrow(RangeError);
  });
});

describe("a span tree produces a stage breakdown (PRD 9.2)", () => {
  function nestedTrace(): ReturnType<ReturnType<typeof createTrace>["finish"]> {
    const clock = manualClock();
    const recorder = createTrace(REQUEST, clock);

    // retrieval { dense, lexical } then fusion, with retrieval as the parent.
    const retrieval = recorder.span("dense-retrieval");
    clock.advance(10);
    const lexical = recorder.span("lexical-retrieval");
    clock.advance(30);
    lexical.end();
    clock.advance(5);
    retrieval.end();

    const fusion = recorder.span("fusion");
    clock.advance(8);
    fusion.end();

    return recorder.finish();
  }

  it("separates self time from inclusive time", () => {
    // The parent ran 45 ms in total and 30 of those were inside its child, so it is answerable
    // for 15. A breakdown that only summed inclusive time would report 75 ms of work in a 53 ms
    // request, which is the shape of number that makes a dashboard untrustworthy.
    const breakdown = stageBreakdown(nestedTrace());
    const dense = breakdown.find((entry) => entry.stage === "dense-retrieval");
    expect(dense?.inclusiveMs).toBe(45);
    expect(dense?.selfMs).toBe(15);
  });

  it("sums self time to the wall time of the request", () => {
    const trace = nestedTrace();
    const self = stageBreakdown(trace).reduce((sum, entry) => sum + entry.selfMs, 0);
    expect(self).toBe(53);
    expect(trace.totalMs).toBe(53);
  });

  it("aggregates a named group from PRD 9.3", () => {
    // "Retrieval stage (both arms + fusion)" is one budget, so it is one lookup.
    expect(groupDuration(nestedTrace(), "retrieval")).toBe(45 + 30 + 8);
  });

  it("records nesting rather than flattening it", () => {
    const spans = nestedTrace().spans;
    const lexical = spans.find((span) => span.stage === "lexical-retrieval");
    const dense = spans.find((span) => span.stage === "dense-retrieval");
    expect(lexical?.parentId).toBe(dense?.id);
    expect(dense?.parentId).toBeNull();
  });
});

describe("a trace refuses to hide a lost span", () => {
  it("throws when finished with a span still open", () => {
    const recorder = createTrace(REQUEST, manualClock());
    recorder.span("generation");
    expect(() => recorder.finish()).toThrow(/still open/);
  });

  it("names the stage that was left open", () => {
    const recorder = createTrace(REQUEST, manualClock());
    recorder.span("verification");
    expect(() => recorder.finish()).toThrow(/verification/);
  });

  it("throws when a span is ended twice", () => {
    const recorder = createTrace(REQUEST, manualClock());
    const span = recorder.span("audit-write");
    span.end();
    expect(() => {
      span.end();
    }).toThrow(/ended twice/);
  });

  it("throws when a span is opened on a finished trace", () => {
    const recorder = createTrace(REQUEST, manualClock());
    recorder.finish();
    expect(() => recorder.span("fusion")).toThrow(/finished trace/);
  });
});

describe("cost comes from the versioned table (PRD 9.2)", () => {
  it("computes from token counts", () => {
    // 1,000,000 input at 1000/1M is exactly 1000; 500,000 output at 2000/1M is exactly 1000.
    const record = costOf(SYNTHETIC_PRICES, "fake-generator", 1_000_000, 500_000);
    expect(record.amountUsd).toBe(2000);
  });

  it("stamps the table version into every record", () => {
    // A cost without the table that produced it is unauditable, so the version is not optional.
    const record = costOf(SYNTHETIC_PRICES, "fake-embedder", 2_000_000, 0);
    expect(record.priceTableVersion).toBe("test-synthetic-1");
    expect(record.amountUsd).toBe(200);
  });

  it("throws for a model the table does not price, rather than returning zero", () => {
    // Zero would make every cost budget in PRD 9.3 pass trivially (ADR 0002).
    expect(() => costOf(SYNTHETIC_PRICES, "unlisted-model", 10, 10)).toThrow(/no price for model/);
  });

  it("prices nothing at all from the table this repository ships", () => {
    expect(UNPRICED_TABLE.models).toEqual({});
    expect(canPrice(UNPRICED_TABLE, "fake-generator")).toBe(false);
    expect(() => costOf(UNPRICED_TABLE, "fake-generator", 1, 1)).toThrow(AtlasOpsError);
  });

  it("rejects negative token counts", () => {
    expect(() => costOf(SYNTHETIC_PRICES, "fake-generator", -1, 0)).toThrow(/non-negative/);
  });

  it("sums records", () => {
    const a = costOf(SYNTHETIC_PRICES, "fake-generator", 1_000_000, 0);
    const b = costOf(SYNTHETIC_PRICES, "fake-embedder", 1_000_000, 0);
    expect(totalCost([a, b])).toBe(1100);
  });
});

describe("cost is attributed to the stage that spent it", () => {
  it("reports cost by stage and in total", () => {
    const clock = manualClock();
    const recorder = createTrace(REQUEST, clock);

    const embedding = recorder.span("embedding");
    clock.advance(4);
    embedding.end({
      model: {
        modelId: "fake-embedder",
        cost: costOf(SYNTHETIC_PRICES, "fake-embedder", 1_000_000, 0),
        cacheHit: false,
        retries: 0,
      },
    });

    const generation = recorder.span("generation");
    clock.advance(12);
    generation.end({
      model: {
        modelId: "fake-generator",
        cost: costOf(SYNTHETIC_PRICES, "fake-generator", 1_000_000, 0),
        cacheHit: true,
        retries: 1,
      },
    });

    const trace = recorder.finish();
    expect(traceCost(trace)).toBe(1100);
    expect(costByStage(trace).get("generation")).toBe(1000);
    expect(costByStage(trace).get("embedding")).toBe(100);
    expect(cacheHitRate(trace)).toBe(0.5);
  });

  it("reports no cache rate when nothing called a model", () => {
    const recorder = createTrace(REQUEST, manualClock());
    recorder.span("fusion").end();
    expect(cacheHitRate(recorder.finish())).toBeNull();
  });
});

describe("degraded modes are visible in the trace (PRD 9.4)", () => {
  it("marks the trace when any stage ran degraded", () => {
    const recorder = createTrace(REQUEST, manualClock());
    recorder.span("reranking").end({ degraded: true });
    const trace = recorder.finish();
    expect(trace.degraded).toBe(true);
  });

  it("leaves an undegraded trace unmarked", () => {
    const recorder = createTrace(REQUEST, manualClock());
    recorder.span("reranking").end();
    expect(recorder.finish().degraded).toBe(false);
  });
});

describe("percentiles are nearest-rank", () => {
  it("returns a value that actually occurred", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it("is the maximum for small samples, which is why sample size travels with every measurement", () => {
    expect(percentileIsMaximumBelow(95)).toBe(20);
    expect(percentile([1, 2, 3], 95)).toBe(3);
  });

  it("refuses a percentile outside (0, 100]", () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("measurements cannot exist without a profile (PRD 9.1)", () => {
  it("carries the profile, sample size and synthetic flag", () => {
    const measurement = measure({
      budgetId: "ANSWER-LATENCY-P95",
      value: 2800,
      unit: "ms",
      profile: PROFILE,
      sampleSize: 240,
      measuredAt: "2026-09-20T12:00:00.000Z",
    });
    expect(measurement.profile.id).toBe("test-profile");
    expect(measurement.synthetic).toBe(true);
  });

  it("refuses a measurement over zero samples", () => {
    expect(() =>
      measure({
        budgetId: "ANSWER-LATENCY-P95",
        value: 0,
        unit: "ms",
        profile: PROFILE,
        sampleSize: 0,
        measuredAt: "2026-09-20T12:00:00.000Z",
      }),
    ).toThrow(/absence of a measurement/);
  });
});

describe("budgets fail loudly and with attribution (PRD 9.3)", () => {
  const latency = budgetById("ANSWER-LATENCY-P95");

  function measurementOf(value: number): ReturnType<typeof measure> {
    return measure({
      budgetId: latency.id,
      value,
      unit: "ms",
      profile: PROFILE,
      sampleSize: 240,
      measuredAt: "2026-09-20T12:00:00.000Z",
    });
  }

  it("passes a measurement inside the target", () => {
    const result = assertWithinBudget(latency, measurementOf(2800), []);
    expect(result.within).toBe(true);
  });

  it("throws rather than warning when the target is exceeded", () => {
    expect(() => assertWithinBudget(latency, measurementOf(3200), [])).toThrow(AtlasOpsError);
  });

  it("reports the stage breakdown with the overshoot", () => {
    // PRD 9.3: an exceeded budget is reported with its breakdown so the response is an
    // engineering decision rather than a retry with a bigger timeout.
    const clock = manualClock();
    const recorder = createTrace(REQUEST, clock);
    const generation = recorder.span("generation");
    clock.advance(2900);
    generation.end();
    const breakdown = stageBreakdown(recorder.finish());

    let message = "";
    try {
      assertWithinBudget(latency, measurementOf(3200), breakdown);
    } catch (error) {
      message = (error as AtlasOpsError).message;
    }

    expect(message).toContain("generation");
    expect(message).toContain("2900");
    expect(message).toContain("not raised to make this pass");
  });

  it("carries the profile into the failure message", () => {
    let message = "";
    try {
      assertWithinBudget(latency, measurementOf(3200), []);
    } catch (error) {
      message = (error as AtlasOpsError).message;
    }
    expect(message).toContain("test-profile");
    expect(message).toContain("240 sample(s)");
  });

  it("refuses to compare a measurement in the wrong unit", () => {
    const wrongUnit = measure({
      budgetId: latency.id,
      value: 1,
      unit: "usd",
      profile: PROFILE,
      sampleSize: 10,
      measuredAt: "2026-09-20T12:00:00.000Z",
    });
    expect(() => checkBudget(latency, wrongUnit)).toThrow(/measured in ms/);
  });

  it("declares every budget from the PRD table with its method", () => {
    expect(BUDGETS).toHaveLength(10);
    for (const budget of BUDGETS) {
      expect(budget.method.length).toBeGreaterThan(0);
      expect(budget.target).toBeGreaterThan(0);
    }
  });
});
