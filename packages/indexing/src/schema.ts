/**
 * The index schema, and what a change to it costs (PRD 4.4, 11.2).
 *
 * The schema carries the embedding model reference, and that is not bookkeeping. PRD 4.4: "an index
 * containing vectors from two embedding models is silently broken, and the only defence is to record
 * the model per vector and refuse mixed-model queries." Putting the model in the schema makes the
 * refusal structural — an index knows which model it is, so a row or a query from another one is a
 * typed failure at the boundary rather than a similarity score that looks fine.
 *
 * **A migration plan is a statement about cost, not a script.** `planMigration` says whether a
 * schema change can be applied in place or forces every vector to be recomputed, and refuses the
 * changes that are not migrations at all. The point is that changing the embedding model is
 * classified as `reindex` by the type system rather than discovered on the day somebody notices
 * recall fell.
 */

import { AtlasOpsError, type EmbeddingModelRef } from "@atlasops/contracts";

export const INDEX_SCHEMA_VERSION = 1;

/**
 * The fields an index row carries, from PRD 4.4's list.
 *
 * Declared rather than derived from the `Chunk` type, because a migration plan has to compare two
 * schemas — one of which may be an older index's, read from disk, describing fields this build no
 * longer has a type for.
 */
export const INDEX_FIELDS = [
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
  "text",
  "vector",
] as const;

export interface IndexSchema {
  readonly version: number;
  readonly embedding: EmbeddingModelRef;
  readonly fields: readonly string[];
}

export function currentSchema(embedding: EmbeddingModelRef): IndexSchema {
  return { version: INDEX_SCHEMA_VERSION, embedding, fields: [...INDEX_FIELDS] };
}

export type MigrationKind =
  /** The schemas agree. */
  | "none"
  /** Fields were added, or the version moved with no change to what a row means. */
  | "in-place"
  /** Every vector must be recomputed. The expensive one, and it is never silent. */
  | "reindex"
  /** Not a migration: a downgrade, or a removal of a field PRD 4.4 requires. */
  | "refused";

export interface MigrationPlan {
  readonly kind: MigrationKind;
  readonly from: IndexSchema;
  readonly to: IndexSchema;
  readonly addedFields: readonly string[];
  readonly removedFields: readonly string[];
  readonly reason: string;
}

export function planMigration(from: IndexSchema, to: IndexSchema): MigrationPlan {
  const addedFields = to.fields.filter((field) => !from.fields.includes(field));
  const removedFields = from.fields.filter((field) => !to.fields.includes(field));
  const base = { from, to, addedFields, removedFields };

  if (to.version < from.version) {
    return {
      ...base,
      kind: "refused",
      reason:
        `the index is at schema version ${String(from.version)} and this build writes ` +
        `${String(to.version)}. Downgrading is not a migration: an older writer cannot know what ` +
        `a newer row means, and writing to it anyway corrupts rows it never reads.`,
    };
  }

  if (removedFields.length > 0) {
    return {
      ...base,
      kind: "refused",
      reason:
        `removing ${removedFields.join(", ")} would leave rows that cannot satisfy PRD 4.4. A ` +
        `chunk missing its embedding reference or its offsets is not a smaller chunk, it is an ` +
        `uncitable one.`,
    };
  }

  if (
    from.embedding.id !== to.embedding.id ||
    from.embedding.dimension !== to.embedding.dimension
  ) {
    return {
      ...base,
      kind: "reindex",
      reason:
        `the embedding model changes from ${describe(from.embedding)} to ${describe(to.embedding)}. ` +
        `Vectors from two models are not comparable, so every row is recomputed — there is no ` +
        `in-place path, and pretending there is produces an index that returns plausible nonsense.`,
    };
  }

  if (addedFields.length > 0) {
    return {
      ...base,
      kind: "in-place",
      reason: `adds ${addedFields.join(", ")}; existing vectors are unaffected`,
    };
  }

  if (from.version !== to.version) {
    return { ...base, kind: "in-place", reason: "version moved with no change to a row's meaning" };
  }

  return { ...base, kind: "none", reason: "the schemas agree" };
}

function describe(model: EmbeddingModelRef): string {
  return `${model.id} (${String(model.dimension)}d)`;
}

/**
 * The guard every adapter runs before it accepts a vector.
 *
 * `MIXED_EMBEDDING_MODEL` rather than a validation error, because the caller's response is
 * different in kind: this is not a malformed input, it is a query that would have compared vectors
 * from two models and returned a ranking nobody can trust.
 */
export function assertSameModel(schema: IndexSchema, model: EmbeddingModelRef, what: string): void {
  if (schema.embedding.id === model.id && schema.embedding.dimension === model.dimension) return;

  throw new AtlasOpsError(
    "MIXED_EMBEDDING_MODEL",
    `${what} uses ${describe(model)} but this index holds ${describe(schema.embedding)}. ` +
      `Comparing them does not fail, it returns plausible nonsense — which is the hardest defect ` +
      `in a retrieval system to notice.`,
  );
}
