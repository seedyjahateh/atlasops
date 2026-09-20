/**
 * The public surface of `@atlasops/corpus`.
 *
 * Layer 3. Imports `@atlasops/contracts` and `@atlasops/governance`; the boundary checker enforces
 * that nothing else gets in, and in particular that this package cannot reach `ingest`, `indexing`,
 * `retrieval` or `grounding`. That direction is the whole point: the corpus decides what exists and
 * what is eligible, and the layers that fetch, chunk, index and rank are told — they do not get to
 * negotiate with it.
 *
 * `@atlasops/telemetry` is permitted by this package's row in `layers.json` and is deliberately not
 * imported. Nothing here measures anything yet; the ingestion budgets in PRD 4.5 are asserted in
 * `ingest`, against a run that actually does work. A dependency declared before it is used is a
 * dependency nobody reviews.
 */

export {
  observedAcl,
  observedVersionId,
  versionFrom,
  type SourceObservation,
} from "./observation.js";

export {
  inMemoryCorpusStore,
  type AclRevision,
  type AppendOutcome,
  type AppendResult,
  type CorpusOrder,
  type CorpusStore,
  type HeadMove,
  type HeadMoveReason,
  type SourceState,
  type Tombstone,
  type VersionRef,
} from "./store.js";

export {
  detectChanges,
  hasWork,
  type ChangeSet,
  type ConnectorListing,
  type ListedSource,
} from "./changes.js";

export { isRetrievable, retentionPlan, versionAsOf, type RetentionPlan } from "./retention.js";
