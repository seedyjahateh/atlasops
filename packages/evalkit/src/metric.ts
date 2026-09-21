/**
 * The shape every metric returns (PRD 8.5).
 *
 * "Per-query scores are retained for every run, not just aggregates."
 *
 * That is made structural rather than remembered: **there is no way to build a `MetricResult`
 * without the per-query scores it was computed from.** `metricResult` is the only constructor, it
 * takes the per-query values, and it derives the aggregate from them. A metric implemented as
 * "return the mean" would have thrown the per-query scores away, and PRD 8.5's paired bootstrap —
 * which is the whole regression gate — would then have nothing to be paired on.
 *
 * The aggregation is named rather than assumed. Most of these metrics are means over queries; leak
 * count is a sum, because one leak in two hundred queries is one leak and not 0.005 of one.
 */

import { AtlasOpsError } from "@atlasops/contracts";

export type Aggregation = "mean" | "sum";

export interface PerQueryScore {
  readonly itemId: string;
  readonly value: number;
}

export interface MetricResult {
  readonly metric: string;
  readonly aggregation: Aggregation;
  /** Derived from `perQuery`. Never supplied. */
  readonly value: number;
  readonly sampleSize: number;
  readonly perQuery: readonly PerQueryScore[];
}

export function metricResult(
  metric: string,
  perQuery: readonly PerQueryScore[],
  aggregation: Aggregation = "mean",
): MetricResult {
  if (perQuery.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${metric}: a metric over zero queries is not zero, it is undefined. An empty aggregate ` +
        `reads as a perfect score for a sum and as NaN for a mean, and both get published.`,
      "metric.perQuery",
    );
  }

  for (const score of perQuery) {
    if (!Number.isFinite(score.value)) {
      throw new AtlasOpsError(
        "VALIDATION",
        `${metric}: query "${score.itemId}" scored ${String(score.value)}`,
        "metric.perQuery",
      );
    }
  }

  const total = perQuery.reduce((sum, score) => sum + score.value, 0);
  return {
    metric,
    aggregation,
    value: aggregation === "sum" ? total : total / perQuery.length,
    sampleSize: perQuery.length,
    perQuery,
  };
}

/** The per-query scores of two runs, paired by item. The input PRD 8.5's bootstrap needs. */
export function pairScores(
  baseline: MetricResult,
  candidate: MetricResult,
): readonly { readonly itemId: string; readonly delta: number }[] {
  const before = new Map(baseline.perQuery.map((score) => [score.itemId, score.value]));

  return candidate.perQuery.flatMap((score) => {
    const previous = before.get(score.itemId);
    // An item only one run scored cannot contribute a delta. Treating its absence as zero would
    // dilute the comparison with queries that were never compared.
    return previous === undefined ? [] : [{ itemId: score.itemId, delta: score.value - previous }];
  });
}
