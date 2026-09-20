/**
 * Budgets (PRD 9.3).
 *
 * Every target here is a **target to be met and proved**, never an achieved figure. Nothing in this
 * repository has been measured, so no number below may be restated anywhere as a result until an
 * artefact produced by the stated method exists (PRD section 0).
 *
 * Three rules from PRD 9.3 shape the API:
 *
 * 1. A budget is enforced against the reference profile — so `assertWithinBudget` takes a
 *    `Measurement`, which cannot be constructed without a profile.
 * 2. The number is never raised to make the build pass. There is deliberately no function here that
 *    mutates a target; changing one is a reviewed edit to this file with an ADR behind it.
 * 3. An exceeded budget is reported **with its stage breakdown**, so the response is an engineering
 *    decision rather than a retry. `assertWithinBudget` refuses to report a bare overshoot.
 */

import { AtlasOpsError } from "@atlasops/contracts";

import type { Measurement } from "./profile.js";
import type { StageTiming } from "./span.js";

export interface Budget {
  readonly id: string;
  readonly target: number;
  readonly unit: "ms" | "usd";
  /** How the number must be produced before it may be cited. Copied from the PRD table. */
  readonly method: string;
}

export const BUDGETS = [
  {
    id: "ANSWER-LATENCY-P95",
    target: 3000,
    unit: "ms",
    method: "scripted load run, fixed workload, stated concurrency",
  },
  {
    id: "TIME-TO-FIRST-TOKEN-P95",
    target: 1200,
    unit: "ms",
    method: "streaming instrumentation on the same run",
  },
  { id: "RETRIEVAL-STAGE-P95", target: 400, unit: "ms", method: "span aggregation" },
  {
    id: "RERANK-STAGE-P95",
    target: 500,
    unit: "ms",
    method: "span aggregation at fixed candidate depth",
  },
  { id: "PERMISSION-P95", target: 50, unit: "ms", method: "span aggregation" },
  { id: "VERIFICATION-P95", target: 100, unit: "ms", method: "span aggregation" },
  {
    id: "COST-PER-ANSWER-P50",
    target: 0.02,
    unit: "usd",
    method: "per-request token accounting x versioned price table",
  },
  {
    id: "COST-PER-ANSWER-P95",
    target: 0.06,
    unit: "usd",
    method: "per-request token accounting x versioned price table",
  },
  {
    id: "INGESTION-COST-PER-1K-CHUNKS",
    target: 0.5,
    unit: "usd",
    method: "embedding token accounting over the fixture",
  },
  {
    id: "RETRIEVAL-ONLY-COST",
    target: 0.001,
    unit: "usd",
    method: "embedding token accounting over the fixture",
  },
] as const satisfies readonly Budget[];

export type BudgetId = (typeof BUDGETS)[number]["id"];

export function budgetById(id: BudgetId): Budget {
  const found = BUDGETS.find((budget) => budget.id === id);
  if (found === undefined) {
    throw new AtlasOpsError("VALIDATION", `no budget "${id}" is declared in PRD 9.3`);
  }
  return found;
}

export interface BudgetResult {
  readonly budget: Budget;
  readonly measurement: Measurement;
  readonly within: boolean;
  /** A line suitable for a report, whether it passed or not. */
  readonly summary: string;
}

function describe(budget: Budget, measurement: Measurement): string {
  const rounded = Math.round(measurement.value * 10000) / 10000;
  return (
    `${budget.id}: ${String(rounded)} ${budget.unit} against a target of ` +
    `${String(budget.target)} ${budget.unit}, over ${String(measurement.sampleSize)} sample(s) ` +
    `on profile "${measurement.profile.id}" at concurrency ` +
    `${String(measurement.profile.concurrency)}${measurement.synthetic ? " (synthetic)" : ""}`
  );
}

export function checkBudget(budget: Budget, measurement: Measurement): BudgetResult {
  if (measurement.unit !== budget.unit) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${budget.id} is measured in ${budget.unit}, but the measurement is in ${measurement.unit}`,
    );
  }
  return {
    budget,
    measurement,
    within: measurement.value <= budget.target,
    summary: describe(budget, measurement),
  };
}

function renderBreakdown(breakdown: readonly StageTiming[]): string {
  if (breakdown.length === 0) return "    (no spans recorded)";
  return breakdown
    .map(
      (timing) =>
        `    ${timing.stage.padEnd(22)} self ${String(Math.round(timing.selfMs))} ms  ` +
        `inclusive ${String(Math.round(timing.inclusiveMs))} ms  x${String(timing.count)}`,
    )
    .join("\n");
}

/**
 * Fails loudly, and never without the breakdown.
 *
 * `breakdown` is required rather than optional on purpose. PRD 9.3 says an exceeded budget is
 * reported with its stage breakdown so the response is an engineering decision; an overshoot with
 * no attribution invites a retry with a bigger timeout, which is the response the rule exists to
 * prevent. For a cost budget, pass the stage timings from the same trace — they are still what
 * tells a reader where the money went.
 */
export function assertWithinBudget(
  budget: Budget,
  measurement: Measurement,
  breakdown: readonly StageTiming[],
): BudgetResult {
  const result = checkBudget(budget, measurement);
  if (result.within) return result;

  throw new AtlasOpsError(
    "BUDGET_EXCEEDED",
    `${result.summary}\n  method: ${budget.method}\n  stage breakdown:\n${renderBreakdown(breakdown)}\n` +
      `  The target is not raised to make this pass (PRD 9.3): fix it, or accept the regression in ` +
      `a reviewed change that says why.`,
  );
}
