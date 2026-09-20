/**
 * Ingestion budgets (PRD 4.5).
 *
 * PRD 4.5 opens with "Targets to be met and proved, not results", and nothing below is a result.
 * Every number here is copied from that table together with the measurement method the PRD names,
 * and no value in this file may be restated anywhere as an achievement until a run produced it.
 *
 * **This is a separate table from PRD 9.3's, and a separate checker, for a reason that is not
 * tidiness.** Two of these five targets are floors rather than ceilings — chunk reuse must be *at
 * least* 90% — and `telemetry`'s checker compares `value <= target` because every 9.3 budget is a
 * ceiling in milliseconds or dollars. Reusing it would have quietly inverted two rows and reported
 * a corpus that reused nothing as comfortably within budget. So `direction` is part of the budget,
 * and the unit set is the one this table actually uses.
 *
 * What is reused from `telemetry` is the part that matters most: `Measurement`, which cannot be
 * constructed without a `ReferenceProfile`. PRD 9.1's "a budget quoted without its profile is not
 * quotable" applies to ingestion exactly as it applies to latency.
 */

import { AtlasOpsError, contentHashOf, type ContentHash } from "@atlasops/contracts";
import {
  costOf,
  type Measurement,
  type PriceTable,
  type ReferenceProfile,
} from "@atlasops/telemetry";

import type { IngestionReport } from "./pipeline.js";

export interface IngestionBudget {
  readonly id: string;
  readonly target: number;
  readonly unit: "calls" | "ratio" | "chunks" | "sources";
  /** Whether the target is a ceiling or a floor. See the file header. */
  readonly direction: "at-most" | "at-least";
  /** Copied from PRD 4.5. How the number must be produced before it may be cited. */
  readonly method: string;
}

export const INGESTION_BUDGETS = [
  {
    id: "UNCHANGED-REINGESTION-CALLS",
    target: 0,
    unit: "calls",
    direction: "at-most",
    method: "connector integration test asserting zero model calls",
  },
  {
    id: "CHUNK-REUSE-ON-EDIT",
    target: 0.9,
    unit: "ratio",
    direction: "at-least",
    method: "fixture diff test over a seeded revision pair",
  },
  {
    id: "DELETION-RESIDUE",
    target: 0,
    unit: "chunks",
    direction: "at-most",
    method: "post-delete probe across both indexes and caches",
  },
  {
    id: "REINGESTION-DIFFS",
    target: 0,
    unit: "chunks",
    direction: "at-most",
    method: "re-run on fixed input, compare chunk hashes",
  },
  {
    id: "FAILURE-COLLATERAL",
    target: 0,
    unit: "sources",
    direction: "at-most",
    method: "fault-injection test on a mixed batch",
  },
] as const satisfies readonly IngestionBudget[];

export type IngestionBudgetId = (typeof INGESTION_BUDGETS)[number]["id"];

export function ingestionBudgetById(id: IngestionBudgetId): IngestionBudget {
  const found = INGESTION_BUDGETS.find((budget) => budget.id === id);
  if (found === undefined) {
    throw new AtlasOpsError("VALIDATION", `no ingestion budget "${id}" is declared in PRD 4.5`);
  }
  return found;
}

export interface IngestionBudgetResult {
  readonly budget: IngestionBudget;
  readonly measurement: Measurement;
  readonly within: boolean;
  readonly summary: string;
}

export function checkIngestionBudget(
  budget: IngestionBudget,
  measurement: Measurement,
): IngestionBudgetResult {
  if (measurement.unit !== budget.unit) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${budget.id} is measured in ${budget.unit}, but the measurement is in ${measurement.unit}`,
    );
  }

  const within =
    budget.direction === "at-most"
      ? measurement.value <= budget.target
      : measurement.value >= budget.target;

  const rounded = Math.round(measurement.value * 10000) / 10000;
  const comparison = budget.direction === "at-most" ? "a ceiling of" : "a floor of";

  return {
    budget,
    measurement,
    within,
    summary:
      `${budget.id}: ${String(rounded)} ${budget.unit} against ${comparison} ` +
      `${String(budget.target)} ${budget.unit}, over ${String(measurement.sampleSize)} sample(s) ` +
      `on profile "${measurement.profile.id}"${measurement.synthetic ? " (synthetic)" : ""}`,
  };
}

/**
 * Fails loudly, and never without evidence.
 *
 * `evidence` is required for the same reason `telemetry`'s checker requires a stage breakdown: a
 * bare overshoot invites somebody to rerun it, and a bare shortfall on a reuse ratio invites
 * somebody to lower the ratio. A line naming which sources were re-embedded, or which chunk
 * identifiers survived a delete, makes the response an engineering decision instead.
 */
export function assertWithinIngestionBudget(
  budget: IngestionBudget,
  measurement: Measurement,
  evidence: readonly string[],
): IngestionBudgetResult {
  const result = checkIngestionBudget(budget, measurement);
  if (result.within) return result;

  const detail =
    evidence.length === 0
      ? "    (none recorded)"
      : evidence.map((line) => `    ${line}`).join("\n");

  throw new AtlasOpsError(
    "BUDGET_EXCEEDED",
    `${result.summary}\n  method: ${budget.method}\n  evidence:\n${detail}\n` +
      `  The target is not moved to make this pass (PRD 9.3, applied to 4.5): fix it, or accept ` +
      `the regression in a reviewed change that says why.`,
  );
}

export interface IngestionProfileInput {
  readonly id: string;
  readonly corpusSnapshot: ContentHash;
  readonly connector: string;
  readonly embeddingModelId: string;
  readonly hardware: string;
}

/**
 * The reference profile for an ingestion run (PRD 9.1).
 *
 * `workload` in PRD 9.1 means the query workload, and an ingestion run has none. Rather than leave
 * the field empty or invent a query set, it records the crawl that *was* the workload: the
 * connector's identity, hashed. It is a real, reproducible statement of what was run, which is what
 * the field is for.
 */
export function ingestionProfile(input: IngestionProfileInput): ReferenceProfile {
  return {
    id: input.id,
    corpusSnapshot: input.corpusSnapshot,
    workload: contentHashOf(`ingestion-crawl:${input.connector}`),
    models: { embedder: input.embeddingModelId },
    hardware: input.hardware,
    concurrency: 1,
  };
}

/**
 * Ingestion cost per 1,000 chunks, for PRD 9.3's budget of the same name.
 *
 * It throws when the model has no price, and that is the intended behaviour rather than a gap.
 * ADR 0002 ships the price table empty because real vendor prices are facts this repository does
 * not hold; returning zero for an unpriced model would make the cost budget pass trivially while
 * the error surfaced on an invoice. So this budget is currently **unmeasurable, not met** — and the
 * distinction is enforced by the call throwing rather than by a note somebody has to read.
 */
export function ingestionCostPer1kChunks(
  report: IngestionReport,
  prices: PriceTable,
  modelId: string,
): number {
  if (report.chunksWritten === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "cost per 1,000 chunks over a run that wrote no chunks is not a small number, it is undefined",
    );
  }
  const cost = costOf(prices, modelId, report.embeddingTokens, 0);
  return (cost.amountUsd / report.chunksWritten) * 1000;
}
