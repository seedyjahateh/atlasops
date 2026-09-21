/**
 * The paired bootstrap (PRD 8.5).
 *
 * "A candidate run is compared to the current baseline by paired comparison on per-query deltas
 * with a bootstrap confidence interval, so that a two-point mean shift driven by four queries out
 * of two hundred is distinguishable from a real change. The gate is defined on the lower bound of
 * the confidence interval rather than the point estimate."
 *
 * **Paired, not two-sample.** The two runs answered the same queries, so the informative quantity
 * is the per-query difference. An unpaired comparison of two means throws away that pairing and
 * measures the spread of query difficulty — which is enormous, swamps the effect, and makes every
 * real improvement look like noise.
 *
 * **Percentile interval, resampling the deltas.** Each resample draws N deltas with replacement and
 * takes their mean; the interval is the 2.5th and 97.5th percentiles of those means. It assumes
 * nothing about the shape of the distribution, which matters because most of these metrics are
 * bounded in [0, 1] and several are mostly zeroes and ones. A normal-theory interval on a metric
 * like that reports bounds outside the metric's own range.
 *
 * **The gate is the lower bound, and it is conservative on purpose.** `withinTolerance` asks
 * whether the interval's lower bound is at or above `-tolerance`, which is a non-inferiority test:
 * "we are confident this is not worse by more than the tolerance". With the default tolerance of
 * zero it will block a noisy run whose point estimate is positive, and that is the intended
 * direction — the remedy for a wide interval is more queries, not a looser gate. The tolerance is
 * marked unselected because PRD section 0 does not permit a number to be chosen here and quoted as
 * tuned; selecting it is a job for the evaluation artefact, like `k` and the support threshold.
 */

import { AtlasOpsError } from "@atlasops/contracts";
import { percentile } from "@atlasops/telemetry";

import { seededRng } from "./rng.js";

export interface BootstrapOptions {
  readonly resamples?: number;
  readonly confidence?: number;
  readonly seed?: number;
}

export const BOOTSTRAP_DEFAULTS = {
  resamples: 2000,
  confidence: 0.95,
  seed: 20260501,
} as const;

export interface BootstrapResult {
  /** The observed mean paired delta. The point estimate the gate deliberately does not use. */
  readonly mean: number;
  readonly lower: number;
  readonly upper: number;
  readonly confidence: number;
  readonly resamples: number;
  readonly seed: number;
  readonly sampleSize: number;
}

export function pairedBootstrap(
  deltas: readonly number[],
  options: BootstrapOptions = {},
): BootstrapResult {
  if (deltas.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "a paired bootstrap over zero pairs is not a wide interval, it is the absence of a " +
        "comparison — the two runs answered no query in common",
      "bootstrap.deltas",
    );
  }

  const resamples = options.resamples ?? BOOTSTRAP_DEFAULTS.resamples;
  const confidence = options.confidence ?? BOOTSTRAP_DEFAULTS.confidence;
  const seed = options.seed ?? BOOTSTRAP_DEFAULTS.seed;

  if (confidence <= 0 || confidence >= 1) {
    throw new AtlasOpsError(
      "VALIDATION",
      `confidence must be in (0, 1), received ${String(confidence)}`,
      "bootstrap.confidence",
    );
  }

  const rng = seededRng(seed);
  const means: number[] = [];

  for (let resample = 0; resample < resamples; resample += 1) {
    // Draw `deltas.length` values with replacement. The counter is not an index into `deltas` —
    // the index comes from the generator — so this is a repeat count rather than an iteration.
    let total = 0;
    let remaining = deltas.length;
    while (remaining > 0) {
      total += deltas[rng.below(deltas.length)] ?? 0;
      remaining -= 1;
    }
    means.push(total / deltas.length);
  }

  const tail = ((1 - confidence) / 2) * 100;
  return {
    mean: deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length,
    lower: percentile(means, tail),
    upper: percentile(means, 100 - tail),
    confidence,
    resamples,
    seed,
    sampleSize: deltas.length,
  };
}

export type ToleranceProvenance = "unselected-default" | "selected-on-dev-split";

export interface GatePolicy {
  /** How much worse a metric may confidently be and still pass. */
  readonly tolerance: number;
  readonly provenance: ToleranceProvenance;
}

export const GATE_DEFAULTS: GatePolicy = {
  tolerance: 0,
  provenance: "unselected-default",
};

/** The gate. Reads the lower bound, never the point estimate. See the file header. */
export function withinTolerance(
  result: BootstrapResult,
  policy: GatePolicy = GATE_DEFAULTS,
): boolean {
  return result.lower >= -policy.tolerance;
}

export type Verdict =
  /** The whole interval is above zero. */
  | "improvement"
  /** The whole interval is below zero. */
  | "regression"
  /** The interval straddles zero: this run does not distinguish the two. */
  | "no-change";

/**
 * What the interval says, which is not the same question as whether the gate passes.
 *
 * A run can be verdict `no-change` and still fail the gate, because the interval straddling zero
 * means the evidence does not rule out a real loss. Reporting them separately keeps "we did not
 * detect a change" from being read as "nothing changed".
 */
export function verdictOf(result: BootstrapResult): Verdict {
  if (result.lower > 0) return "improvement";
  if (result.upper < 0) return "regression";
  return "no-change";
}
