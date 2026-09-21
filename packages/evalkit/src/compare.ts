/**
 * Regression detection (PRD 8.5) and PRD 8.3's third control.
 *
 * Two rules decide whether a candidate run ships, and neither is a threshold on a mean.
 *
 * **Every metric is compared by paired bootstrap, and the gate reads the interval's lower bound.**
 * The point estimate is reported and deliberately not used to decide: a two-point mean shift driven
 * by four queries out of two hundred has an interval that straddles zero, and the whole purpose of
 * the machinery is to tell that apart from a real change.
 *
 * **A judged improvement paired with a retrieval regression is a regression.** PRD 8.3: "Judged
 * metrics are never used alone to gate a release; a judged improvement paired with a retrieval
 * regression is treated as a regression." This is the rule that catches the failure mode the whole
 * of 8.3 is about — a change that makes the judge happier while making retrieval worse is the
 * signature of the judge's bias being mistaken for a quality improvement, and it is the case where
 * a naive "more green than red" summary ships the wrong thing.
 *
 * Direction matters and is not guessed. `LOWER_IS_BETTER` names the metrics where a positive delta
 * is a loss — over-abstention, contradiction, leak count — and the comparison flips their sign
 * before the bootstrap, so "improvement" means the same thing in every row. Getting this wrong
 * would report a rise in leaks as an improvement, which is the sort of defect that survives review
 * because the table looks right.
 */

import { AtlasOpsError } from "@atlasops/contracts";

import {
  GATE_DEFAULTS,
  pairedBootstrap,
  verdictOf,
  withinTolerance,
  type BootstrapOptions,
  type BootstrapResult,
  type GatePolicy,
  type Verdict,
} from "./bootstrap.js";
import { metricsOf, type RunReport } from "./harness.js";
import { requireSameJudge } from "./judge.js";
import { pairScores, type MetricResult } from "./metric.js";

/** Metrics where a larger number is worse. See the file header. */
export const LOWER_IS_BETTER: ReadonlySet<string> = new Set([
  "over-abstention",
  "contradiction-rate",
  "leak-count",
  "existence-disclosure",
  "cost-per-answer",
]);

/** Metrics a judge produced. Subject to PRD 8.3's third control. */
export const JUDGED_METRICS: ReadonlySet<string> = new Set([
  "supported-claim-rate",
  "contradiction-rate",
]);

/** Metrics that speak to retrieval quality, for the same rule. */
export const RETRIEVAL_METRICS: ReadonlySet<string> = new Set(["recall@10", "nDCG@10", "MRR"]);

export interface MetricComparison {
  readonly metric: string;
  /** Sign-corrected, so a positive delta always means better. */
  readonly bootstrap: BootstrapResult;
  readonly verdict: Verdict;
  readonly passesGate: boolean;
  readonly lowerIsBetter: boolean;
}

export interface ComparisonReport {
  readonly baseline: string;
  readonly candidate: string;
  readonly metrics: readonly MetricComparison[];
  readonly gate: GatePolicy;
  readonly verdict: Verdict;
  /** Why the overall verdict is what it is, in words a reviewer can act on. */
  readonly reason: string;
  readonly passed: boolean;
}

function compareMetric(
  baseline: MetricResult,
  candidate: MetricResult,
  gate: GatePolicy,
  options: BootstrapOptions,
): MetricComparison {
  const lowerIsBetter = LOWER_IS_BETTER.has(candidate.metric);
  const deltas = pairScores(baseline, candidate).map((pair) =>
    lowerIsBetter ? -pair.delta : pair.delta,
  );

  const bootstrap = pairedBootstrap(deltas, options);
  return {
    metric: candidate.metric,
    bootstrap,
    verdict: verdictOf(bootstrap),
    passesGate: withinTolerance(bootstrap, gate),
    lowerIsBetter,
  };
}

export interface CompareOptions extends BootstrapOptions {
  readonly gate?: GatePolicy;
}

export function compareRuns(
  baseline: RunReport,
  candidate: RunReport,
  options: CompareOptions = {},
): ComparisonReport {
  if (baseline.arm !== candidate.arm) {
    throw new AtlasOpsError(
      "VALIDATION",
      `these runs are different arms (${baseline.arm} and ${candidate.arm}). Comparing them ` +
        `measures the ablation, not the change.`,
      "compare.arm",
    );
  }

  if (baseline.datasets.join("|") !== candidate.datasets.join("|")) {
    throw new AtlasOpsError(
      "VALIDATION",
      `these runs used different dataset versions:\n  ${baseline.datasets.join("\n  ")}\nand\n  ` +
        `${candidate.datasets.join("\n  ")}\nPRD 8.1: re-labelling the hard queries is one of the ` +
        `two most effective ways to fake an improvement, so a comparison across versions is not ` +
        `one.`,
      "compare.datasets",
    );
  }

  requireSameJudge(baseline.judge, candidate.judge);

  const gate = options.gate ?? GATE_DEFAULTS;
  const before = new Map(metricsOf(baseline).map((metric) => [metric.metric, metric]));

  const metrics = metricsOf(candidate).flatMap((metric) => {
    const previous = before.get(metric.metric);
    return previous === undefined ? [] : [compareMetric(previous, metric, gate, options)];
  });

  if (metrics.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "these runs share no metric, so there is nothing to compare",
      "compare.metrics",
    );
  }

  const judgedImprovements = metrics.filter(
    (entry) => JUDGED_METRICS.has(entry.metric) && entry.verdict === "improvement",
  );
  const retrievalRegressions = metrics.filter(
    (entry) => RETRIEVAL_METRICS.has(entry.metric) && entry.verdict === "regression",
  );
  const regressions = metrics.filter((entry) => entry.verdict === "regression");
  const failures = metrics.filter((entry) => !entry.passesGate);

  // PRD 8.3's third control, applied before anything else can call this a win.
  if (judgedImprovements.length > 0 && retrievalRegressions.length > 0) {
    return {
      baseline: baseline.runId,
      candidate: candidate.runId,
      metrics,
      gate,
      verdict: "regression",
      reason:
        `judged improvement (${judgedImprovements.map((entry) => entry.metric).join(", ")}) ` +
        `alongside a retrieval regression ` +
        `(${retrievalRegressions.map((entry) => entry.metric).join(", ")}). PRD 8.3 treats this ` +
        `as a regression: a change that pleases the judge while retrieval gets worse is what the ` +
        `judge's bias looks like from the inside.`,
      passed: false,
    };
  }

  if (regressions.length > 0) {
    return {
      baseline: baseline.runId,
      candidate: candidate.runId,
      metrics,
      gate,
      verdict: "regression",
      reason: `confident regression on ${regressions.map((entry) => entry.metric).join(", ")}`,
      passed: false,
    };
  }

  const improvements = metrics.filter((entry) => entry.verdict === "improvement");
  const passed = failures.length === 0;

  return {
    baseline: baseline.runId,
    candidate: candidate.runId,
    metrics,
    gate,
    verdict: improvements.length > 0 ? "improvement" : "no-change",
    reason: passed
      ? improvements.length > 0
        ? `confident improvement on ${improvements.map((entry) => entry.metric).join(", ")}`
        : "no metric moved beyond what this sample can distinguish from noise"
      : `the interval's lower bound is below the tolerance on ` +
        `${failures.map((entry) => entry.metric).join(", ")}. The point estimate is not the gate ` +
        `(PRD 8.5); the remedy for a wide interval is more queries, not a looser tolerance.`,
    passed,
  };
}

export interface ArmDelta {
  readonly metric: string;
  readonly arm: string;
  readonly against: string;
  readonly bootstrap: BootstrapResult;
  readonly verdict: Verdict;
}

/**
 * The ablation deltas PRD 8.2 row 2 asks for.
 *
 * Every arm against the full one, on the same dataset version. This is the comparison that entitles
 * the project to the claim in PRD 5.1 — without it, the architecture is an assertion. It is a
 * different operation from `compareRuns` on purpose: an ablation is not a regression, and running
 * it through the release gate would report "dense-only is worse" as a build failure.
 */
export function compareArms(
  runs: readonly RunReport[],
  reference: string,
  options: BootstrapOptions = {},
): readonly ArmDelta[] {
  const full = runs.find((run) => run.arm === reference);
  if (full === undefined) {
    throw new AtlasOpsError(
      "VALIDATION",
      `no run for the reference arm "${reference}"`,
      "compare.arms",
    );
  }

  const fullMetrics = new Map(metricsOf(full).map((metric) => [metric.metric, metric]));

  return runs
    .filter((run) => run.arm !== reference)
    .flatMap((run) =>
      metricsOf(run).flatMap((metric) => {
        const other = fullMetrics.get(metric.metric);
        if (other === undefined) return [];

        const lowerIsBetter = LOWER_IS_BETTER.has(metric.metric);
        const deltas = pairScores(other, metric).map((pair) =>
          lowerIsBetter ? -pair.delta : pair.delta,
        );
        if (deltas.length === 0) return [];

        const bootstrap = pairedBootstrap(deltas, options);
        return [
          {
            metric: metric.metric,
            arm: run.arm,
            against: reference,
            bootstrap,
            verdict: verdictOf(bootstrap),
          },
        ];
      }),
    );
}
