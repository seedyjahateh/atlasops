/**
 * The chunk contract (PRD 4.4).
 *
 * Section 4.4 lists what every chunk reaching the index must carry. Three of those fields are
 * enforced here as invariants rather than merely typed, because each of them fails silently:
 *
 * - `chunkId` must agree with `sourceVersionId` and `ordinal`. It is derived, so a chunk whose id
 *   disagrees was assembled by something that did not go through `formatChunkId`, and its identity
 *   will not survive re-ingestion.
 * - the character span must be non-empty and ordered, because a citation into a zero-width span is
 *   unverifiable and the verification pass in PRD 7.2 would have nothing to check.
 * - `embedding.id` is mandatory. PRD 4.4 is explicit that an index holding vectors from two models
 *   is silently broken and the only defence is recording the model per vector.
 */

import { parseAclLabel, type AclLabel } from "./acl.js";
import { AtlasOpsError, ValidationError } from "./errors.js";
import { requireContentHash, type ContentHash } from "./hash.js";
import {
  decomposeChunkId,
  parseChunkId,
  parseSourceId,
  parseSourceVersionId,
  type ChunkId,
  type SourceId,
  type SourceVersionId,
} from "./ids.js";
import {
  rejectUnknownKeys,
  requireInstant,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireStringArray,
  requireNullable,
} from "./validate.js";

/** Which model produced a vector, and how wide it is. Never optional — see the file header. */
export interface EmbeddingModelRef {
  readonly id: string;
  readonly dimension: number;
}

export interface Chunk {
  readonly chunkId: ChunkId;
  readonly sourceId: SourceId;
  readonly sourceVersionId: SourceVersionId;
  /** Position within the source version. Zero-based. */
  readonly ordinal: number;
  /** Headings from document root to this chunk, so a passage can be rendered with its location. */
  readonly headingPath: readonly string[];
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenCount: number;
  readonly contentHash: ContentHash;
  /** The date the content takes effect, when the source declares one. */
  readonly effectiveDate: string | null;
  readonly acl: AclLabel;
  readonly embedding: EmbeddingModelRef;
}

const CHUNK_FIELDS = [
  "chunkId",
  "sourceId",
  "sourceVersionId",
  "ordinal",
  "headingPath",
  "charStart",
  "charEnd",
  "tokenCount",
  "contentHash",
  "effectiveDate",
  "acl",
  "embedding",
] as const;

const EMBEDDING_FIELDS = ["id", "dimension"] as const;

function parseEmbeddingRef(value: unknown, path: string): EmbeddingModelRef {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, EMBEDDING_FIELDS, path);
  return {
    id: requireString(record.id, `${path}.id`),
    dimension: requirePositiveInteger(record.dimension, `${path}.dimension`),
  };
}

export function parseChunk(value: unknown, path = "chunk"): Chunk {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, CHUNK_FIELDS, path);

  const sourceVersionId = parseSourceVersionId(record.sourceVersionId, `${path}.sourceVersionId`);
  const chunkId = parseChunkId(record.chunkId, `${path}.chunkId`);
  const ordinal = requireNonNegativeInteger(record.ordinal, `${path}.ordinal`);

  const decomposed = decomposeChunkId(chunkId);
  if (decomposed.sourceVersionId !== sourceVersionId || decomposed.ordinal !== ordinal) {
    throw new ValidationError(
      `${path}.chunkId`,
      `"${chunkId}" does not agree with sourceVersionId "${sourceVersionId}" and ordinal ` +
        `${String(ordinal)}. A chunk identifier is derived, not allocated — one that disagrees was ` +
        `not produced by formatChunkId and will change on re-ingestion.`,
    );
  }

  const charStart = requireNonNegativeInteger(record.charStart, `${path}.charStart`);
  const charEnd = requireNonNegativeInteger(record.charEnd, `${path}.charEnd`);
  if (charEnd <= charStart) {
    throw new ValidationError(
      `${path}.charEnd`,
      `expected charEnd (${String(charEnd)}) to be greater than charStart (${String(charStart)}); ` +
        `a zero-width span cannot support a citation`,
    );
  }

  return {
    chunkId,
    sourceId: parseSourceId(record.sourceId, `${path}.sourceId`),
    sourceVersionId,
    ordinal,
    headingPath: requireStringArray(record.headingPath, `${path}.headingPath`),
    charStart,
    charEnd,
    tokenCount: requirePositiveInteger(record.tokenCount, `${path}.tokenCount`),
    contentHash: requireContentHash(record.contentHash, `${path}.contentHash`),
    effectiveDate: requireNullable(record.effectiveDate, `${path}.effectiveDate`, requireInstant),
    acl: parseAclLabel(record.acl, `${path}.acl`),
    embedding: parseEmbeddingRef(record.embedding, `${path}.embedding`),
  };
}

/**
 * Refuse a candidate set whose vectors come from more than one embedding model (PRD 4.4).
 *
 * Called before any operation that compares vectors. The failure is loud on purpose: a mixed-model
 * index does not error, it returns plausible nonsense, and plausible nonsense from a retrieval
 * system is the hardest defect there is to notice.
 */
export function assertSingleEmbeddingModel(chunks: Iterable<Chunk>): EmbeddingModelRef | null {
  let seen: EmbeddingModelRef | null = null;

  for (const chunk of chunks) {
    if (seen === null) {
      seen = chunk.embedding;
      continue;
    }
    if (seen.id !== chunk.embedding.id || seen.dimension !== chunk.embedding.dimension) {
      throw new AtlasOpsError(
        "MIXED_EMBEDDING_MODEL",
        `candidate set mixes embedding models: "${seen.id}" (${String(seen.dimension)}d) and ` +
          `"${chunk.embedding.id}" (${String(chunk.embedding.dimension)}d). Vectors from different ` +
          `models are not comparable, and comparing them fails silently rather than loudly.`,
      );
    }
  }

  return seen;
}
