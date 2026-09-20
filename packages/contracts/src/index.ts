/**
 * The public surface of `@atlasops/contracts`.
 *
 * This file is the package's contract with every layer above it. PRD 11.3 mechanism 1 makes the
 * `exports` map the reviewable artefact rather than an emergent property of whatever files happen
 * to exist, so anything not re-exported here is private by construction — deep imports into
 * `src/` do not resolve.
 */

export {
  ERROR_CODES,
  AtlasOpsError,
  ValidationError,
  isAtlasOpsError,
  type ErrorCode,
} from "./errors.js";

export {
  contentHashOf,
  contentHashDigest,
  isContentHash,
  requireContentHash,
  type ContentHash,
} from "./hash.js";

/**
 * The one validation primitive that is also a format every layer above records.
 *
 * Exported rather than kept private because the alternative is each layer writing its own instant
 * check, and the subtlety here — `new Date("2026-13-45")` does not throw, so validation has to be a
 * re-serialise-and-compare round trip — is precisely the part that gets reimplemented wrongly. The
 * rest of `validate.ts` stays private: those are this package's own parsing internals.
 */
export { requireInstant } from "./validate.js";

export {
  formatSourceId,
  parseSourceId,
  formatPrincipalId,
  parsePrincipalId,
  formatGroupId,
  parseGroupId,
  formatRequestId,
  parseRequestId,
  formatSourceVersionId,
  parseSourceVersionId,
  sourceVersionContentHash,
  formatChunkId,
  parseChunkId,
  decomposeChunkId,
  type SourceId,
  type SourceVersionId,
  type ChunkId,
  type PrincipalId,
  type GroupId,
  type RequestId,
} from "./ids.js";

export {
  EXISTENCE_POLICIES,
  canRead,
  parseAclLabel,
  readableByPredicate,
  requireResolvedAcl,
  type AclLabel,
  type ExistencePolicy,
} from "./acl.js";

export {
  assertSingleEmbeddingModel,
  parseChunk,
  type Chunk,
  type EmbeddingModelRef,
} from "./chunk.js";

export { isUnchanged, parseSourceVersion, type SourceVersion } from "./source.js";

export {
  ABSTENTION_REASONS,
  citedChunkIds,
  parseAnswer,
  renderProse,
  type AbstentionReason,
  type Abstention,
  type Answer,
  type ClaimSegment,
  type GroundedAnswer,
  type Reference,
  type Span,
} from "./answer.js";
