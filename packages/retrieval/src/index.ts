/**
 * The public surface of `@atlasops/retrieval`.
 *
 * Layer 5. It imports `contracts`, `telemetry`, `indexing`, `governance` and `model-gateway` —
 * every dependency its row in PRD 11.2 allows, and notably **not `corpus`**. The layer that decides
 * what is current must not be reachable from the layer that ranks, so "is this the live version" is
 * a port here and an application answers it from the corpus.
 *
 * Nothing in this package filters a candidate for permission reasons, because nothing reaches it
 * that the principal may not read. The predicate is compiled once and applied by both indexes
 * during candidate generation, which is PRD 6.2's requirement and `indexing`'s responsibility.
 */

export {
  RETRIEVAL_DEFAULTS,
  ablate,
  configKey,
  validateConfig,
  type ArmConfig,
  type ConfigProvenance,
  type RetrievalConfig,
} from "./config.js";

export { STOPWORDS, analyseQuery, type AnalysedQuery } from "./query.js";

export {
  reciprocalRankFusion,
  type Contribution,
  type FusedCandidate,
  type RankedList,
} from "./fusion.js";

export {
  admits,
  requireScope,
  staticVersionOracle,
  type StaticOracleInput,
  type TemporalScope,
  type VersionOracle,
  type VersionWindow,
} from "./temporal.js";

export {
  inMemoryRetrievalCache,
  retrievalCacheKey,
  type RecordingRetrievalCache,
  type RetrievalCache,
} from "./cache.js";

export {
  retrieve,
  type DegradedReason,
  type RetrievalPorts,
  type RetrievalRequest,
  type RetrievalResult,
} from "./retrieve.js";
