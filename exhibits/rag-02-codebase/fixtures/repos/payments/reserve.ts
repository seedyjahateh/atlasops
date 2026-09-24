/**
 * The refund reserve.
 *
 * Readable by the payments team only. The percentage is set from trailing refund volume, not from
 * the window customers see.
 */

export interface MonthlyVolume {
  readonly month: string;
  readonly revenue: number;
  readonly refunds: number;
}

/** The reserve rate: refunds over revenue across the trailing twelve months. */
export function reserveRate(history: readonly MonthlyVolume[]): number {
  const trailing = history.slice(-12);
  const revenue = trailing.reduce((sum, month) => sum + month.revenue, 0);
  const refunds = trailing.reduce((sum, month) => sum + month.refunds, 0);
  return revenue === 0 ? 0 : refunds / revenue;
}

/** The amount to hold this month, at the trailing rate. */
export function reserveFor(history: readonly MonthlyVolume[], currentRevenue: number): number {
  return currentRevenue * reserveRate(history);
}
