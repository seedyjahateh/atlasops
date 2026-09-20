/**
 * Nearest-rank percentiles.
 *
 * No interpolation. An interpolated p95 over twenty samples reports a number that no request
 * actually experienced, which is precisely the wrong property for a latency budget: the question
 * "did any real request exceed 3,000 ms" should not be answered by a weighted average of two that
 * did not.
 *
 * The consequence worth knowing, and worth stating wherever these numbers are published: over N
 * samples with N ≤ 20, the nearest-rank p95 **is** the maximum. A p95 quoted from a handful of
 * samples is a maximum wearing a percentile's name, and the sample count travels with every
 * measurement in this package for exactly that reason.
 */

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  if (p <= 0 || p > 100) {
    throw new RangeError(`percentile must be in (0, 100], received ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

/** The sample count at or below which a nearest-rank percentile equals the maximum. */
export function percentileIsMaximumBelow(p: number): number {
  return Math.floor(100 / (100 - p));
}
