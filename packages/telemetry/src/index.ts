/**
 * The public surface of `@atlasops/telemetry`.
 *
 * Layer 1. Imports `@atlasops/contracts` and nothing else internal; the boundary checker enforces
 * that rather than this comment.
 */

export { manualClock, systemClock, type Clock, type ManualClock } from "./clock.js";

export { STAGES, STAGE_GROUPS, isStage, type Stage, type StageGroup } from "./stages.js";

export { percentile, percentileIsMaximumBelow } from "./percentile.js";

export {
  UNPRICED_TABLE,
  canPrice,
  checkedPriceTable,
  costOf,
  totalCost,
  type CostRecord,
  type ModelPrice,
  type PriceTable,
} from "./prices.js";

export {
  measure,
  type Measurement,
  type MeasurementInput,
  type ReferenceProfile,
} from "./profile.js";

export {
  cacheHitRate,
  costByStage,
  createTrace,
  groupDuration,
  stageBreakdown,
  traceCost,
  type ModelCall,
  type Span,
  type SpanEnd,
  type SpanHandle,
  type StageTiming,
  type Trace,
  type TraceRecorder,
} from "./span.js";

export {
  BUDGETS,
  assertWithinBudget,
  budgetById,
  checkBudget,
  type Budget,
  type BudgetId,
  type BudgetResult,
} from "./budget.js";
