/**
 * The public surface of `@atlasops/evalkit`, at P10a.
 *
 * Layer 7. It imports `contracts`, `telemetry`, `retrieval`, `grounding` and `governance` — and
 * notably not `indexing`, `corpus`, `ingest` or `model-gateway`. That is why nothing here runs a
 * system: this phase is functions over labelled data and recorded outputs. The harness that drives
 * an answer system arrives in P10b and takes it as a port, which is also what keeps the harness
 * able to evaluate something other than this repository's own wiring.
 *
 * Two shapes are load-bearing and neither is a convention anybody has to remember. A `MetricResult`
 * cannot be built without the per-query scores it came from (PRD 8.5), and the leak gate throws
 * rather than returning a number (PRD 8.4).
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
