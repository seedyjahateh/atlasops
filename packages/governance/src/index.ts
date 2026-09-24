/**
 * The public surface of `@atlasops/governance`.
 *
 * Layer 2. Imports `@atlasops/contracts` and `@atlasops/telemetry`; the boundary checker enforces
 * that nothing else gets in.
 *
 * **`canRead` from contracts is deliberately not re-exported here.** It is a pure predicate and a
 * perfectly good one, but reaching an authorisation decision through this package must go through
 * `journal.authorize`, which records it. Re-exporting the unaudited predicate from the governance
 * surface would make the unaudited path the convenient one.
 */

export {
  normaliseGroups,
  parseGroupMap,
  resolvePrincipal,
  staticGroupResolver,
  unavailableGroupResolver,
  type GroupResolver,
  type Principal,
} from "./principal.js";

export { computeCacheKey, groupSetHash, permissionedCacheKey } from "./groupset.js";

export {
  ABSTENTION_OUTCOMES,
  abstentionMessage,
  outcomeFor,
  type AbstentionOutcome,
} from "./existence.js";

export {
  createAuthorizationJournal,
  failingAuditSink,
  inMemoryAuditSink,
  releaseAnswer,
  type AuditRecord,
  type AuditSink,
  type AuthorizationDecision,
  type AuthorizationJournal,
  type ChunkReference,
  type DecisionReason,
  type RecordingAuditSink,
  type SealInput,
} from "./audit.js";
