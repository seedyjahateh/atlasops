/**
 * Turning a load run into the numbers PRD 9.3 names, and refusing to invent the rest.
 *
 * The shape that matters here is that **every budget row is present**, and each one is either a
 * measurement with its sample size or an explicit statement of why it could not be measured. A
 * report that silently omitted the rows it could not fill would read as a clean sheet — which is
 * the reading PRD section 0 exists to prevent, and the one a reader in a hurry will take.
 *
 * Three rows cannot be measured by this run, and none of them is a technicality:
 *
 * - **Time to first token** needs streaming instrumentation, and the adapter has none (ADR 0006).
 * - **Cost per answer**, at both percentiles, needs a priced model. Every model here is a stand-in,
 *   and a stand-in has no price (ADR 0002); reporting zero would make both budgets pass trivially.
 * - **Ingestion cost per 1,000 chunks** and **retrieval-only cost** are the same problem: token
 *   counts exist, the price does not.
 */

import {
  budgetById,
  checkBudget,
  measure,
  percentile,
  percentileIsMaximumBelow,
  BUDGETS,
  STAGE_GROUPS,
  type Budget,
  type BudgetId,
  type ReferenceProfile,
  type Stage,
} from "@atlasops/telemetry";

import type { LoadRunResult, RequestSample } from "./harness.js";

export interface LatencyRow {
  readonly stage: string;
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
  /** True when the p95 rests on so few samples that it is the maximum wearing a percentile's name. */
  readonly p95IsMaximum: boolean;
}

export interface BudgetRow {
  readonly id: string;
  readonly target: number;
  readonly unit: string;
  readonly method: string;
  /** Null when the run could not measure it; `unmeasured` then says why. */
  readonly value: number | null;
  readonly sampleSize: number | null;
  readonly within: boolean | null;
  readonly unmeasured: string | null;
  /**
   * Something true of this measurement that the number alone does not say.
   *
   * It lives in the record rather than only in the rendered report, because the record is what CI
   * reads and what a later phase will quote. A caveat that exists only in prose is one that is lost
   * the first time somebody copies the figure.
   */
  readonly caveat: string | null;
}

export interface LoadRunRecord {
  readonly profile: ReferenceProfile;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly commit: string | null;
  readonly requests: number;
  readonly abstentions: number;
  readonly chunksIngested: number;
  /**
   * Requests retrieval served from cache, and the rate.
   *
   * PRD 9.2 asks for cache hit rate by cache. This run can answer for the retrieval cache; the
   * embedding cache's hits happen inside retrieval and are reported to it rather than to the
   * harness, so the report names that gap rather than printing one number for "the cache".
   */
  readonly retrievalCacheHits: number;
  readonly retrievalCacheHitRate: number;
  readonly latency: readonly LatencyRow[];
  readonly budgets: readonly BudgetRow[];
}

/** Every self-time recorded for a stage, across every request. */
function selfTimesFor(samples: readonly RequestSample[], stages: readonly Stage[]): number[] {
  const wanted = new Set<string>(stages);
  const values: number[] = [];

  for (const sample of samples) {
    let total = 0;
    let seen = false;
    for (const timing of sample.stages) {
      if (!wanted.has(timing.stage)) continue;
      total += timing.selfMs;
      seen = true;
    }
    // Per request rather than per span: the budget is "the retrieval stage, p95", which is a
    // property of a request. Pooling spans would let one request with three spans outvote one with
    // one, and the percentile would describe spans rather than answers.
    if (seen) values.push(total);
  }

  return values;
}

function rowFor(stage: string, values: readonly number[]): LatencyRow {
  return {
    stage,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    samples: values.length,
    // `percentileIsMaximumBelow` returns the sample count at or below which nearest-rank returns
    // the maximum — 20 for p95. A p95 over fewer samples than that is the largest value observed.
    p95IsMaximum: values.length <= percentileIsMaximumBelow(95),
  };
}

function latencyRows(result: LoadRunResult): readonly LatencyRow[] {
  const cold = result.samples.filter((sample) => !sample.cacheHit);
  const warm = result.samples.filter((sample) => sample.cacheHit);

  /**
   * Three end-to-end rows, not one.
   *
   * A cache hit and a cache miss are different pieces of work, and a run whose workload repeats
   * answers mostly from the cache: the first run of this harness put 247 of 260 requests through it
   * and reported the result as an answer latency inside a 3,000 ms budget. The combined row is what
   * a caller experiences, the split rows are what the system does, and a reader needs all three to
   * know which they are looking at.
   */
  const rows: LatencyRow[] = [
    rowFor(
      "end-to-end",
      result.samples.map((sample) => sample.totalMs),
    ),
    rowFor(
      "end-to-end (retrieval cache miss)",
      cold.map((sample) => sample.totalMs),
    ),
    rowFor(
      "end-to-end (retrieval cache hit)",
      warm.map((sample) => sample.totalMs),
    ),
  ];

  const stages = new Set<Stage>();
  for (const sample of result.samples) {
    for (const timing of sample.stages) stages.add(timing.stage);
  }

  for (const stage of [...stages].sort()) {
    rows.push(rowFor(stage, selfTimesFor(result.samples, [stage])));
  }

  return rows;
}

interface Measured {
  readonly values: readonly number[];
}

/** Which budgets this run can fill, and from what. */
function valuesFor(id: BudgetId, result: LoadRunResult): Measured | string {
  switch (id) {
    case "ANSWER-LATENCY-P95":
      return { values: result.samples.map((sample) => sample.totalMs) };
    case "RETRIEVAL-STAGE-P95":
      return { values: selfTimesFor(result.samples, [...STAGE_GROUPS.retrieval]) };
    case "RERANK-STAGE-P95":
      return { values: selfTimesFor(result.samples, ["reranking"]) };
    case "PERMISSION-P95":
      return { values: selfTimesFor(result.samples, [...STAGE_GROUPS.permissions]) };
    case "VERIFICATION-P95":
      return { values: selfTimesFor(result.samples, ["verification"]) };
    case "TIME-TO-FIRST-TOKEN-P95":
      return (
        "no streaming instrumentation exists. The OpenAI adapter speaks the non-streaming " +
        "endpoint (ADR 0006), and a first-token time cannot be inferred from a whole-response " +
        "latency"
      );
    case "COST-PER-ANSWER-P50":
    case "COST-PER-ANSWER-P95":
      return (
        "every model in this run is a stand-in and a stand-in has no price (ADR 0002). Reporting " +
        "zero would make this budget pass trivially while the real figure surfaced on an invoice"
      );
    case "INGESTION-COST-PER-1K-CHUNKS":
    case "RETRIEVAL-ONLY-COST":
      return (
        "token counts exist for this run; a price for the model that produced them does not " +
        "(ADR 0002). The denominator is real and the rate is not"
      );
    default:
      return "this run does not produce a value for this budget";
  }
}

/**
 * What a figure does not say about itself.
 *
 * Only the end-to-end budget has one so far, and it is the caveat the first run needed: with a
 * repeating workload most requests are answered from the retrieval cache, so the p95 describes a
 * cache lookup rather than an answer — and passes a three-second budget on that basis.
 */
function caveatFor(budget: Budget, result: LoadRunResult): string | null {
  if (budget.id !== "ANSWER-LATENCY-P95") return null;
  if (result.samples.length === 0) return null;

  const hits = result.retrievalCacheHits;
  const share = hits / result.samples.length;
  if (share < 0.5) return null;

  return (
    `${String(hits)} of ${String(result.samples.length)} requests were served from the retrieval ` +
    `cache, so this figure is mostly the cost of a cache lookup rather than of an answer. The ` +
    `cache-miss row in the latency table is the one to read for the answer path.`
  );
}

function budgetRow(budget: Budget, result: LoadRunResult, measuredAt: string): BudgetRow {
  const outcome = valuesFor(budget.id as BudgetId, result);

  if (typeof outcome === "string") {
    return {
      id: budget.id,
      target: budget.target,
      unit: budget.unit,
      method: budget.method,
      value: null,
      sampleSize: null,
      within: null,
      unmeasured: outcome,
      caveat: null,
    };
  }

  if (outcome.values.length === 0) {
    return {
      id: budget.id,
      target: budget.target,
      unit: budget.unit,
      method: budget.method,
      value: null,
      sampleSize: null,
      within: null,
      unmeasured: "the run recorded no span for this stage",
      caveat: null,
    };
  }

  const measurement = measure({
    budgetId: budget.id,
    value: percentile(outcome.values, 95),
    unit: budget.unit,
    profile: result.profile,
    sampleSize: outcome.values.length,
    measuredAt,
    synthetic: true,
  });
  const checked = checkBudget(budget, measurement);

  return {
    id: budget.id,
    target: budget.target,
    unit: budget.unit,
    method: budget.method,
    value: measurement.value,
    sampleSize: measurement.sampleSize,
    within: checked.within,
    unmeasured: null,
    caveat: caveatFor(budget, result),
  };
}

export function recordOf(result: LoadRunResult, commit: string | null): LoadRunRecord {
  const measuredAt = result.finishedAt;

  return {
    profile: result.profile,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    commit,
    requests: result.samples.length,
    abstentions: result.samples.filter((sample) => sample.abstained).length,
    chunksIngested: result.chunksIngested,
    retrievalCacheHits: result.retrievalCacheHits,
    retrievalCacheHitRate:
      result.samples.length === 0 ? 0 : result.retrievalCacheHits / result.samples.length,
    latency: latencyRows(result),
    budgets: BUDGETS.map((budget) => budgetRow(budget, result, measuredAt)),
  };
}

export interface BudgetBreach {
  readonly id: string;
  readonly value: number;
  readonly target: number;
  readonly unit: string;
}

/** Budgets a committed record shows as exceeded. What CI fails on. */
export function breachesIn(record: LoadRunRecord): readonly BudgetBreach[] {
  return record.budgets
    .filter((row) => row.within === false && row.value !== null)
    .map((row) => ({
      id: row.id,
      value: row.value ?? 0,
      target: row.target,
      unit: row.unit,
    }));
}

/** Budget identifiers the record leaves unmeasured — reported, never treated as passing. */
export function unmeasuredIn(record: LoadRunRecord): readonly BudgetRow[] {
  return record.budgets.filter((row) => row.unmeasured !== null);
}

export { budgetById };
