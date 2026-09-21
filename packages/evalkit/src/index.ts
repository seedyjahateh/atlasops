/**
 * The public surface of `@atlasops/evalkit`.
 *
 * Layer 7. It imports `contracts`, `telemetry`, `retrieval`, `grounding` and `governance` — and
 * notably not `indexing`, `corpus`, `ingest` or `model-gateway`. The system under test is therefore
 * a port, which it should have been anyway: a harness that could only evaluate this repository's
 * own wiring could not be used to evaluate a change to that wiring, which is the one thing it
 * exists for.
 *
 * Four shapes are load-bearing, and none of them is a convention anybody has to remember. A
 * `MetricResult` cannot be built without the per-query scores it came from (PRD 8.5). The leak gate
 * throws rather than returning a number (PRD 8.4). Judged metrics cannot be obtained without the
 * judge-human agreement that qualifies them (PRD 8.3). And the release gate reads a confidence
 * interval's lower bound, never the point estimate (PRD 8.5).
 */

export {
  DATASET_KINDS,
  datasetContentHash,
  datasetRef,
  loadDataset,
  seal,
  type Dataset,
  type DatasetInput,
  type DatasetItem,
  type DatasetKind,
  type SealedDataset,
  type Split,
  type UnsealedSplit,
} from "./dataset.js";

export type {
  AbstentionItem,
  GroundedAnswerItem,
  PermissionProbeItem,
  RelevanceItem,
} from "./shapes.js";

export {
  metricResult,
  pairScores,
  type Aggregation,
  type MetricResult,
  type PerQueryScore,
} from "./metric.js";

export {
  meanReciprocalRank,
  ndcgAt,
  perRetrieverContribution,
  recallAt,
  type FusedOutcome,
  type RankedOutcome,
} from "./retrieval-metrics.js";

export {
  citationPrecision,
  citationRecall,
  spanValidityRate,
  type AnswerOutcome,
} from "./citation-metrics.js";

export {
  correctAbstentionRate,
  overAbstentionRate,
  type AbstentionOutcome,
} from "./abstention-metrics.js";

export {
  assertNoLeaks,
  existenceDisclosureCount,
  leakCount,
  leaksFor,
  type GovernanceGate,
  type ProbeOutcome,
} from "./governance-metrics.js";

export { seededRng, type Rng } from "./rng.js";

export {
  BOOTSTRAP_DEFAULTS,
  GATE_DEFAULTS,
  pairedBootstrap,
  verdictOf,
  withinTolerance,
  type BootstrapOptions,
  type BootstrapResult,
  type GatePolicy,
  type ToleranceProvenance,
  type Verdict,
} from "./bootstrap.js";

export {
  describeJudge,
  fixtureJudge,
  judgedMetrics,
  requireSameJudge,
  sameJudge,
  type Judge,
  type JudgeIdentity,
  type JudgeRequest,
  type JudgedMetrics,
  type JudgedOutcome,
  type Judgement,
} from "./judge.js";

export { ARMS, configForArm, type ArmName } from "./arms.js";

export {
  metricsOf,
  runEvaluation,
  type AnswerSystem,
  type LatencyRow,
  type QueryRecord,
  type RunInput,
  type RunReport,
  type SystemObservation,
  type SystemQuery,
  type TableRow,
} from "./harness.js";

export {
  JUDGED_METRICS,
  LOWER_IS_BETTER,
  RETRIEVAL_METRICS,
  compareArms,
  compareRuns,
  type ArmDelta,
  type CompareOptions,
  type ComparisonReport,
  type MetricComparison,
} from "./compare.js";

export { renderComparison, renderRunReport } from "./report.js";
