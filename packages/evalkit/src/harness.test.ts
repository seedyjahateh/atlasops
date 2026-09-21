/**
 * Harness, statistics and reporting tests (P10b).
 *
 * The two tests that matter most are the ones the PRD's own sentences name. A two-point mean shift
 * driven by four queries out of two hundred must not be called an improvement, and a uniform
 * two-point shift over the same two hundred must be — same mean, different verdicts, which is the
 * entire reason the bootstrap is here. And a judged improvement paired with a retrieval regression
 * must come out as a regression, which is PRD 8.3's third control and the case where a naive "more
 * green than red" summary ships the wrong thing.
 *
 * The system under test is a real `AnswerSystem` built from `retrieval`'s and `grounding`'s own
 * types — not a stub of the harness's internals. Scripting it per item is what lets a leak, an
 * abstention and a miscitation be arranged deliberately.
 */

import {
  contentHashOf,
  formatGroupId,
  formatRequestId,
  formatSourceId,
  formatSourceVersionId,
  parsePrincipalId,
  type ChunkId,
  type GroupId,
} from "@atlasops/contracts";
import {
  abstentionMessage,
  createAuthorizationJournal,
  groupSetHash,
  type Principal,
} from "@atlasops/governance";
import { assemblePrompt, assessSupport, type GroundingResult } from "@atlasops/grounding";
import {
  RETRIEVAL_DEFAULTS,
  analyseQuery,
  type FusedCandidate,
  type RetrievalResult,
} from "@atlasops/retrieval";
import { UNPRICED_TABLE, createTrace, type Clock } from "@atlasops/telemetry";
import { describe, expect, it } from "vitest";

import { ARMS, configForArm } from "./arms.js";
import {
  BOOTSTRAP_DEFAULTS,
  GATE_DEFAULTS,
  pairedBootstrap,
  verdictOf,
  withinTolerance,
} from "./bootstrap.js";
import { compareArms, compareRuns } from "./compare.js";
import { loadDataset, type Dataset, type DatasetInput } from "./dataset.js";
import { fixtureJudge, judgedMetrics, requireSameJudge, type JudgedOutcome } from "./judge.js";
import { metricResult } from "./metric.js";
import { renderComparison, renderRunReport } from "./report.js";
import {
  runEvaluation,
  type AnswerSystem,
  type RunReport,
  type SystemObservation,
} from "./harness.js";
import { seededRng } from "./rng.js";
import type {
  AbstentionItem,
  GroundedAnswerItem,
  PermissionProbeItem,
  RelevanceItem,
} from "./shapes.js";

/* -------------------------------------------------------------------------------- fixtures */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAW = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/datasets.v1.json", import.meta.url)), "utf8"),
) as Record<string, DatasetInput<never>>;

const relevance = loadDataset(RAW.relevance as unknown as DatasetInput<RelevanceItem>);
const grounded = loadDataset(RAW.groundedAnswers as unknown as DatasetInput<GroundedAnswerItem>);
const abstention = loadDataset(RAW.abstention as unknown as DatasetInput<AbstentionItem>);
const probes = loadDataset(RAW.permissionProbe as unknown as DatasetInput<PermissionProbeItem>);

const A = "chk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0";
const B = "chk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_0";
const D = "chk_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd_0";

const ENGINEERING: GroupId = formatGroupId("engineering");
const ALICE: Principal = { id: parsePrincipalId("prn_alice", "fixture"), groups: [ENGINEERING] };
const JUDGE = fixtureJudge({ modelId: "fixture-judge", promptVersion: "v1" });
const NOW = (): string => "2026-05-01T00:00:00.000Z";

/** A clock that moves on every read, so latencies are non-zero and deterministic. */
function tickingClock(step: number): Clock {
  let at = 0;
  return {
    now: (): number => {
      at += step;
      return at;
    },
  };
}

const TEXT: Readonly<Record<string, string>> = {
  [A]: "The refund window is thirty days from delivery.",
  [B]: "ERR_5521 means the ledger is locked.",
  [D]: "Quarterly ledger, finance only.",
};

function candidateFor(
  chunkId: string,
  rank: number,
  retrievers: readonly string[],
): FusedCandidate {
  return {
    chunkId: chunkId as ChunkId,
    sourceId: formatSourceId(`s${String(rank)}`),
    sourceVersionId: formatSourceVersionId(contentHashOf(chunkId)),
    headingPath: ["Handbook"],
    text: TEXT[chunkId] ?? "passage",
    acl: { readableBy: [ENGINEERING], existence: "visible" },
    score: 1,
    rank,
    fusedScore: 1 / (60 + rank),
    contributions: retrievers.map((retriever) => ({ retriever, rank })),
    rerankScore: 1 / rank,
  };
}

/** What a scripted system does for one item. */
interface Script {
  readonly returns: readonly string[];
  readonly cites?: readonly string[];
  readonly abstains?: boolean;
  readonly retrievers?: readonly string[];
}

function observationFor(
  itemId: string,
  query: string,
  script: Script,
  clock: Clock,
): SystemObservation {
  const candidates = script.returns.map((chunkId, index) =>
    candidateFor(chunkId, index + 1, script.retrievers ?? ["dense", "lexical"]),
  );
  const analysed = analyseQuery(query);
  const requestId = formatRequestId(`r${contentHashOf(itemId).slice(7, 15)}`);

  const trace = createTrace(requestId, clock);
  trace.span("fusion").end();

  const retrieval: RetrievalResult = {
    candidates,
    predicate: {
      groups: ALICE.groups,
      groupSetHash: groupSetHash(ALICE.groups),
      filter: { op: "any-group", groups: ALICE.groups },
    },
    query: analysed,
    config: RETRIEVAL_DEFAULTS,
    degraded: [],
    cacheHit: false,
    trace: trace.finish(),
    existence: candidates.length === 0 ? { visibleWithheld: 0, excluded: [] } : null,
    supersededRemoved: 0,
  };

  const prompt = assemblePrompt(analysed.normalised, candidates);
  const journal = createAuthorizationJournal({
    requestId,
    principal: ALICE,
    queryHash: analysed.hash,
  });

  const cited = script.abstains === true ? [] : (script.cites ?? script.returns.slice(0, 1));
  const promptChunks = candidates.map((candidate) => ({
    chunkId: candidate.chunkId,
    sourceVersionId: candidate.sourceVersionId,
  }));

  const answer: GroundingResult["answer"] =
    script.abstains === true
      ? { requestId, abstained: true, reason: "low-support" }
      : {
          requestId,
          abstained: false,
          segments: cited.map((chunkId) => ({
            text: TEXT[chunkId] ?? "a claim",
            references: [
              {
                chunkId: chunkId as ChunkId,
                sourceVersionId: formatSourceVersionId(contentHashOf(chunkId)),
                span: { start: 0, end: 5 },
              },
            ],
          })),
        };

  const audit = journal.seal({
    promptChunks,
    citedChunks: promptChunks.filter((entry) => cited.includes(entry.chunkId)),
    models: ["fake-generator"],
    inputTokens: 100,
    outputTokens: 20,
    costUsd: null,
    stageTimings: [],
    writtenAt: NOW(),
  });

  const grounding: GroundingResult = {
    answer,
    message:
      script.abstains === true
        ? abstentionMessage("nothing-relevant")
        : cited.map((chunkId) => TEXT[chunkId] ?? "").join(" "),
    prose: answer.abstained ? "" : answer.segments.map((segment) => segment.text).join(" "),
    prompt,
    support: assessSupport(candidates),
    verifications: [],
    audit,
    attempts: script.abstains === true ? 0 : 1,
  };

  return { retrieval, grounding };
}

function scriptedSystem(name: string, scripts: Readonly<Record<string, Script>>): AnswerSystem {
  const clock = tickingClock(7);
  return {
    name,
    answer: (query): Promise<SystemObservation> =>
      Promise.resolve(
        observationFor(query.itemId, query.query, scripts[query.itemId] ?? { returns: [] }, clock),
      ),
  };
}

/** The good system: finds the right chunk for every item and never touches the forbidden one. */
const GOOD: Readonly<Record<string, Script>> = {
  "rel-001": { returns: [A, B] },
  "rel-002": { returns: [B] },
  "rel-003": { returns: [] },
  "grd-001": { returns: [A] },
  "grd-002": { returns: [B] },
  "grd-003": { returns: [] },
  "abs-001": { returns: [], abstains: true },
  "abs-002": { returns: [A] },
  "abs-003": { returns: [], abstains: true },
  "abs-004": { returns: [B] },
  "prb-001": { returns: [], abstains: true },
  "prb-002": { returns: [A] },
  "prb-003": { returns: [], abstains: true },
};

async function run(
  scripts: Readonly<Record<string, Script>>,
  overrides: Partial<Parameters<typeof runEvaluation>[0]> = {},
): Promise<RunReport> {
  return runEvaluation({
    system: scriptedSystem("scripted", scripts),
    arm: "fused-with-rerank",
    baseConfig: RETRIEVAL_DEFAULTS,
    relevance,
    grounded,
    abstention,
    probes,
    judge: JUDGE,
    prices: UNPRICED_TABLE,
    now: NOW,
    ...overrides,
  });
}

/* ------------------------------------------------------------------------------------ arms */

describe("the ablation arms (PRD 8.2)", () => {
  it("names all four", () => {
    expect([...ARMS]).toEqual([
      "dense-only",
      "lexical-only",
      "fused-no-rerank",
      "fused-with-rerank",
    ]);
  });

  it("changes only the switches between arms", () => {
    const dense = configForArm(RETRIEVAL_DEFAULTS, "dense-only");
    expect(dense.lexical.enabled).toBe(false);
    expect(dense.rerank.enabled).toBe(false);
    // Everything else comes from the base unchanged: an ablation whose arms also differ in depth
    // is not an ablation of the arm.
    expect(dense.fusionK).toBe(RETRIEVAL_DEFAULTS.fusionK);
    expect(dense.limit).toBe(RETRIEVAL_DEFAULTS.limit);
    expect(dense.dense.depth).toBe(RETRIEVAL_DEFAULTS.dense.depth);
  });

  it("produces four distinct configurations", () => {
    const keys = new Set(ARMS.map((arm) => JSON.stringify(configForArm(RETRIEVAL_DEFAULTS, arm))));
    expect(keys.size).toBe(4);
  });
});

/* ------------------------------------------------------------------------------------- rng */

describe("the seeded generator", () => {
  it("repeats exactly for a given seed", () => {
    const first = Array.from({ length: 5 }, () => seededRng(42).next());
    const second = Array.from({ length: 5 }, () => seededRng(42).next());
    expect(first).toEqual(second);
  });

  it("differs between seeds", () => {
    expect(seededRng(1).next()).not.toBe(seededRng(2).next());
  });

  it("stays inside the bound", () => {
    const rng = seededRng(7);
    for (let draw = 0; draw < 500; draw += 1) {
      const value = rng.below(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });
});

/* ------------------------------------------------------------------------------- bootstrap */

describe("the paired bootstrap (PRD 8.5)", () => {
  it("does not call a shift driven by a handful of queries an improvement", () => {
    // PRD 8.5's concern, stated precisely: the mean is positive, and it is the residue of a few
    // queries that moved in both directions. Most resamples draw more losses than gains, so the
    // interval crosses zero and the method declines to call it a change.
    const deltas = [...Array<number>(190).fill(0), 1, 1, 1, 1, 1, -0.8, -0.8, -0.8, -0.8, -0.8];
    const result = pairedBootstrap(deltas);

    expect(result.mean).toBeCloseTo(0.005, 10);
    expect(result.lower).toBeLessThan(0);
    expect(verdictOf(result)).toBe("no-change");
  });

  it("does call the same mean shift an improvement when every query moved", () => {
    const deltas = Array<number>(200).fill(0.005);
    const result = pairedBootstrap(deltas);

    // Identical mean, opposite verdict. That difference is the whole reason the bootstrap is here.
    expect(result.mean).toBeCloseTo(0.005, 10);
    expect(result.lower).toBeGreaterThan(0);
    expect(verdictOf(result)).toBe("improvement");
  });

  it("does call a uniform gain across a few queries an improvement, because it is one", () => {
    // Worth asserting the other direction too: four queries out of two hundred each improving by
    // a full point, with nothing getting worse, is a real gain and the method says so. The
    // machinery is for telling noise from signal, not for refusing small samples on principle.
    const deltas = [...Array<number>(196).fill(0), 1, 1, 1, 1];
    expect(verdictOf(pairedBootstrap(deltas))).toBe("improvement");
  });

  it("calls a uniform loss a regression", () => {
    const result = pairedBootstrap(Array<number>(200).fill(-0.02));
    expect(result.upper).toBeLessThan(0);
    expect(verdictOf(result)).toBe("regression");
  });

  it("gates on the lower bound, not the point estimate", () => {
    // Mean is positive; the interval reaches below zero, so the gate refuses it.
    const deltas = [...Array<number>(190).fill(0), 1, 1, 1, 1, 1, 1, -1, -1, -1, -1];
    const result = pairedBootstrap(deltas);

    expect(result.mean).toBeGreaterThan(0);
    expect(result.lower).toBeLessThan(0);
    expect(withinTolerance(result, GATE_DEFAULTS)).toBe(false);
  });

  it("passes a run that did not move at all", () => {
    const result = pairedBootstrap(Array<number>(50).fill(0));
    expect(result.lower).toBe(0);
    expect(withinTolerance(result)).toBe(true);
  });

  it("repeats exactly for a fixed seed, and the seed travels on the result", () => {
    const deltas = [0.1, -0.2, 0.3, 0, 0.05, -0.01, 0.2, 0.15];
    const a = pairedBootstrap(deltas, { seed: 99 });
    const b = pairedBootstrap(deltas, { seed: 99 });
    const c = pairedBootstrap(deltas, { seed: 100 });

    expect(a).toEqual(b);
    expect(a.seed).toBe(99);
    expect(a.lower).not.toBe(c.lower);
  });

  it("ships an unselected tolerance, like every other number not yet measured", () => {
    expect(GATE_DEFAULTS.provenance).toBe("unselected-default");
    expect(BOOTSTRAP_DEFAULTS.confidence).toBe(0.95);
  });

  it("refuses a comparison over no pairs", () => {
    expect(() => pairedBootstrap([])).toThrow(/absence of a comparison/);
  });
});

/* ----------------------------------------------------------------------------------- judge */

describe("judged metrics carry their controls (PRD 8.3)", () => {
  const items = grounded.items.filter((item) => item.split === "development");

  it("reports agreement alongside, never separately", () => {
    const outcomes: JudgedOutcome[] = items.map((item) => ({
      itemId: item.id,
      judgement: { supported: true, contradicted: false },
    }));
    const results = judgedMetrics(items, outcomes, JUDGE.identity);

    expect(results.supportedClaimRate.value).toBe(1);
    expect(results.agreement.value).toBe(1);
    expect(results.calibrationSize).toBe(2);
    expect(results.identity.promptVersion).toBe("v1");
  });

  it("scores partial agreement per dimension rather than exact match", () => {
    // The judge got `supported` right and `contradicted` wrong: half agreement, not zero.
    const outcomes: JudgedOutcome[] = items.map((item) => ({
      itemId: item.id,
      judgement: { supported: true, contradicted: true },
    }));
    expect(judgedMetrics(items, outcomes, JUDGE.identity).agreement.value).toBe(0.5);
  });

  it("refuses to report a judged metric with no calibration subset", () => {
    const unlabelled: GroundedAnswerItem[] = items.map((item) => ({
      id: item.id,
      split: item.split,
      query: item.query,
      principal: item.principal,
      referenceAnswer: item.referenceAnswer,
      supportingChunks: item.supportingChunks,
    }));
    const outcomes: JudgedOutcome[] = unlabelled.map((item) => ({
      itemId: item.id,
      judgement: { supported: true, contradicted: false },
    }));
    expect(() => judgedMetrics(unlabelled, outcomes, JUDGE.identity)).toThrow(/agreement/);
  });

  it("refuses to compare runs judged by a different prompt version", () => {
    expect(() => {
      requireSameJudge(
        { modelId: "fixture-judge", promptVersion: "v1" },
        { modelId: "fixture-judge", promptVersion: "v2" },
      );
    }).toThrow(/invalidates comparison/);
  });

  it("refuses to compare a judged run against an unjudged one", () => {
    expect(() => {
      requireSameJudge(JUDGE.identity, null);
    }).toThrow(/no judge/);
  });
});

/* --------------------------------------------------------------------------------- harness */

describe("the harness (PRD 8.2)", () => {
  it("emits a row for every dimension in the 8.2 table", async () => {
    const report = await run(GOOD);
    expect(report.table.map((row) => row.dimension)).toEqual([
      "Retrieval",
      "Fusion and rerank",
      "Citation",
      "Groundedness",
      "Abstention",
      "Governance",
      "Cost and latency",
    ]);
  });

  it("retains a per-query record for every query it asked", async () => {
    const report = await run(GOOD);
    const asked =
      relevance.items.length +
      grounded.items.length +
      abstention.items.length +
      probes.items.length;
    expect(report.perQuery).toHaveLength(asked);
    expect(report.perQuery[0]?.latencyMs).toBeGreaterThan(0);
  });

  it("records which splits it evaluated", async () => {
    const report = await run(GOOD);
    expect(report.splits).toEqual(["development", "held-out"]);
  });

  it("says why a dimension is missing rather than omitting the row", async () => {
    const report = await run(GOOD, { probes: undefined, judge: undefined });
    const governance = report.table.find((row) => row.dimension === "Governance");
    const groundedness = report.table.find((row) => row.dimension === "Groundedness");

    expect(governance?.metrics).toEqual([]);
    expect(governance?.unavailable).toContain("no permission probe set");
    expect(groundedness?.unavailable).toContain("string-matched");
  });

  it("runs the governance gate inside the run, so a leak produces no report", async () => {
    const leaky = { ...GOOD, "prb-001": { returns: [D] } };
    await expect(run(leaky)).rejects.toThrow(/build failure and not a score decline/);
  });

  it("reports cost as unmeasurable against the empty price table", async () => {
    const report = await run(GOOD);
    expect(report.costPerAnswer).toBeNull();
    const row = report.table.find((dimension) => dimension.dimension === "Cost and latency");
    expect(row?.unavailable).toContain("ADR 0002");
  });

  it("names itself from what it ran, so two identical runs agree", async () => {
    const first = await run(GOOD);
    const second = await run(GOOD);
    expect(first.runId).toBe(second.runId);
  });

  it("carries the judge's identity onto the report", async () => {
    const report = await run(GOOD);
    expect(report.judge).toEqual({ modelId: "fixture-judge", promptVersion: "v1" });
  });
});

/* --------------------------------------------------------------------------------- compare */

describe("regression detection (PRD 8.5, 8.3)", () => {
  it("finds no change between a run and itself", async () => {
    const report = await run(GOOD);
    const comparison = compareRuns(report, await run(GOOD));

    expect(comparison.verdict).toBe("no-change");
    expect(comparison.passed).toBe(true);
  });

  it("refuses to compare two different arms", async () => {
    const base = await run(GOOD);
    const other = await run(GOOD, { arm: "dense-only" });
    expect(() => compareRuns(base, other)).toThrow(/measures the ablation, not the change/);
  });

  it("refuses to compare across dataset versions", async () => {
    const base = await run(GOOD);
    const relabelled: Dataset<RelevanceItem> = { ...relevance, version: "2.0.0" };
    const other = await run(GOOD, { relevance: relabelled });
    expect(() => compareRuns(base, other)).toThrow(/fake an improvement/);
  });

  it("refuses to compare across a judge change", async () => {
    const base = await run(GOOD);
    const other = await run(GOOD, {
      judge: fixtureJudge({ modelId: "fixture-judge", promptVersion: "v2" }),
    });
    expect(() => compareRuns(base, other)).toThrow(/invalidates comparison/);
  });

  it("declines to call a three-query collapse a regression, because three queries cannot", async () => {
    // Every relevance query in the fixture now returns nothing, so recall falls from 1 to 0 on
    // both development items. The verdict is still `no-change`: over three pairs, more than 2.5%
    // of resamples draw only the unchanged one, so the interval reaches zero. That is the gate
    // working — a fixture this small cannot support a confident verdict, and saying so is more
    // useful than a confident answer it has not earned. The gate still fails the run.
    const baseline = await run(GOOD);
    const worse = await run({ ...GOOD, "rel-001": { returns: [] }, "rel-002": { returns: [] } });

    const comparison = compareRuns(baseline, worse);
    expect(comparison.verdict).toBe("no-change");
    expect(comparison.passed).toBe(false);
    expect(comparison.reason).toContain("more queries, not a looser tolerance");
  });

  it("calls a confident retrieval regression a regression", () => {
    const comparison = compareRuns(
      syntheticReport("before", { "recall@10": 0.9, "supported-claim-rate": 0.5 }),
      syntheticReport("after", { "recall@10": 0.5, "supported-claim-rate": 0.5 }),
    );

    expect(comparison.verdict).toBe("regression");
    expect(comparison.passed).toBe(false);
    expect(comparison.reason).toContain("confident regression");
  });

  it("treats a judged improvement beside a retrieval regression as a regression", () => {
    // PRD 8.3's third control, and the case a "more green than red" summary gets wrong: the
    // change pleased the judge while retrieval got worse, which is what the judge's bias looks
    // like from the inside.
    const comparison = compareRuns(
      syntheticReport("before", { "recall@10": 0.9, "supported-claim-rate": 0.5 }),
      syntheticReport("after", { "recall@10": 0.5, "supported-claim-rate": 0.9 }),
    );

    expect(comparison.verdict).toBe("regression");
    expect(comparison.reason).toContain("judged improvement");
    expect(comparison.reason).toContain("PRD 8.3");
  });

  it("calls a clean improvement an improvement", () => {
    const comparison = compareRuns(
      syntheticReport("before", { "recall@10": 0.5 }),
      syntheticReport("after", { "recall@10": 0.9 }),
    );

    expect(comparison.verdict).toBe("improvement");
    expect(comparison.passed).toBe(true);
  });

  it("flips the sign of a metric where a larger number is worse", async () => {
    const baseline = await run(GOOD);
    // Over-abstention rises: the system now refuses an answerable query.
    const candidate = await run({ ...GOOD, "abs-002": { returns: [], abstains: true } });

    const comparison = compareRuns(baseline, candidate);
    const over = comparison.metrics.find((metric) => metric.metric === "over-abstention");
    expect(over?.lowerIsBetter).toBe(true);
    // A rise in over-abstention must read as a negative delta, not a positive one.
    expect(over?.bootstrap.mean).toBeLessThan(0);
  });

  it("reports an ablation as deltas rather than as a build failure", async () => {
    const full = await run(GOOD);
    const dense = await run(
      { ...GOOD, "rel-001": { returns: [A], retrievers: ["dense"] } },
      { arm: "dense-only" },
    );

    const deltas = compareArms([full, dense], "fused-with-rerank");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((delta) => delta.against === "fused-with-rerank")).toBe(true);
    expect(deltas.some((delta) => delta.arm === "dense-only")).toBe(true);
  });

  it("refuses an ablation with no reference arm", async () => {
    const full = await run(GOOD);
    expect(() => compareArms([full], "lexical-only")).toThrow(/no run for the reference arm/);
  });
});

/**
 * A report carrying only the metrics a comparison test needs, over forty queries.
 *
 * The fixture datasets have two or three items each, which is not enough for a bootstrap to reach
 * a confident verdict — and pretending otherwise by enlarging the fixture until the numbers came
 * out would be arranging the evidence. The verdict logic is what these tests are about, so they
 * feed it per-query scores directly.
 */
function syntheticReport(runId: string, values: Readonly<Record<string, number>>): RunReport {
  const metrics = Object.entries(values).map(([metric, value]) =>
    metricResult(
      metric,
      Array.from({ length: 40 }, (_unused, index) => ({ itemId: `q${String(index)}`, value })),
    ),
  );

  return {
    runId,
    system: "synthetic",
    arm: "fused-with-rerank",
    models: { generator: "synthetic" },
    commit: null,
    datasets: ["relevance@1.0.0"],
    splits: ["development"],
    table: [{ dimension: "Synthetic", metrics, unavailable: null }],
    latency: [],
    costPerAnswer: null,
    perQuery: [],
    governance: null,
    judge: JUDGE.identity,
    measuredAt: NOW(),
  };
}

/* ---------------------------------------------------------------------------------- report */

describe("the report artefact (PRD 8, 12)", () => {
  it("prints the dataset versions and the corpus snapshot at the top", async () => {
    const rendered = renderRunReport(await run(GOOD));
    expect(rendered).toContain("relevance@1.0.0");
    expect(rendered).toContain("grounded-answers@1.1.0");
    expect(rendered).toContain("corpus sha256:");
  });

  it("prints a sample size beside every number", async () => {
    const rendered = renderRunReport(await run(GOOD));
    expect(rendered).toContain("| Metric | Value | Queries | Aggregation |");
  });

  it("prints the reason a dimension was not measured", async () => {
    const rendered = renderRunReport(await run(GOOD, { judge: undefined }));
    expect(rendered).toContain("_Not measured:");
  });

  it("warns that a p95 over a small sample is a maximum", async () => {
    const rendered = renderRunReport(await run(GOOD));
    expect(rendered).toContain("maximum wearing a percentile's name");
  });

  it("says on its face when a run read the held-out split", async () => {
    const rendered = renderRunReport(await run(GOOD));
    expect(rendered).toContain("This run read the held-out split");
  });

  it("prints the interval bounds and the seed in a comparison", async () => {
    const rendered = renderComparison(compareRuns(await run(GOOD), await run(GOOD)));
    expect(rendered).toContain("| Metric | Δ (point) | CI lower | CI upper |");
    expect(rendered).toContain("percentile bootstrap");
    expect(rendered).toContain(`seed ${String(BOOTSTRAP_DEFAULTS.seed)}`);
    expect(rendered).toContain("lower bound, not the point estimate");
  });
});
