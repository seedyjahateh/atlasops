/**
 * The reference profile (PRD 9.1).
 *
 * "A budget quoted without its profile is not quotable." That sentence is enforced here by making
 * the profile a required field of every `Measurement`: there is no constructor that produces a
 * measured number without also recording the corpus snapshot, workload, pinned models, hardware and
 * concurrency it came from.
 *
 * This is the difference between "p95 latency is 2,800 ms" — which is not a claim about anything —
 * and "p95 latency over 240 queries of workload `w1` against corpus snapshot `sha256:…` at
 * concurrency 8 on the stated hardware is 2,800 ms", which somebody else can reproduce or dispute.
 */

import type { ContentHash } from "@atlasops/contracts";

export interface ReferenceProfile {
  readonly id: string;
  /** The corpus the run was made against, by content. */
  readonly corpusSnapshot: ContentHash;
  /** The query workload, by content. */
  readonly workload: ContentHash;
  /** Pinned model identifiers by role — embedder, reranker, generator, judge. */
  readonly models: Readonly<Record<string, string>>;
  /** Free text, deliberately: "8 vCPU, 32 GB, eu-west-1" is more use than a schema. */
  readonly hardware: string;
  readonly concurrency: number;
}

export interface Measurement {
  readonly budgetId: string;
  readonly value: number;
  readonly unit: string;
  readonly profile: ReferenceProfile;
  /**
   * How many samples produced `value`. Travels with it always, because a nearest-rank p95 over
   * twenty samples is the maximum, and a reader cannot tell that from the number alone.
   */
  readonly sampleSize: number;
  readonly measuredAt: string;
  /** True unless the run was against real traffic. Nothing here produces real traffic yet. */
  readonly synthetic: boolean;
}

export interface MeasurementInput {
  readonly budgetId: string;
  readonly value: number;
  readonly unit: string;
  readonly profile: ReferenceProfile;
  readonly sampleSize: number;
  readonly measuredAt: string;
  readonly synthetic?: boolean;
}

/**
 * The only way to build a `Measurement`.
 *
 * Rejects an empty sample, because a measurement over zero samples is not a small measurement — it
 * is the absence of one, and `NaN` propagating into a budget comparison reads as a pass.
 */
export function measure(input: MeasurementInput): Measurement {
  if (!Number.isInteger(input.sampleSize) || input.sampleSize <= 0) {
    throw new RangeError(
      `${input.budgetId}: a measurement needs at least one sample, received ` +
        `${String(input.sampleSize)}. Zero samples is the absence of a measurement, not a small one.`,
    );
  }
  if (!Number.isFinite(input.value)) {
    throw new RangeError(
      `${input.budgetId}: value must be finite, received ${String(input.value)}`,
    );
  }
  return {
    budgetId: input.budgetId,
    value: input.value,
    unit: input.unit,
    profile: input.profile,
    sampleSize: input.sampleSize,
    measuredAt: input.measuredAt,
    synthetic: input.synthetic ?? true,
  };
}
