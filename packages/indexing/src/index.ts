/**
 * The public surface of `@atlasops/indexing`.
 *
 * Layer 4, alongside `ingest`, and neither imports the other. That is why `IndexRow` exists beside
 * `ingest`'s `StoredChunk` rather than being shared: an application wires a chunker to an index,
 * and an application is the layer allowed to know about both.
 *
 * **There is no exported way to read a row without a compiled predicate.** `RowStore.visible` takes
 * one, the two adapters take one, and nothing here returns an unfiltered set. PRD 6.2's requirement
 * is therefore a property of the API rather than a rule callers have to remember, and a post-filter
 * cannot be written against this package without first writing the unfiltered accessor it does not
 * have.
 */

export {
  compilePredicate,
  groupsToVisit,
  renderPredicate,
  type CompiledPredicate,
  type PermissionFilter,
} from "./predicate.js";

export {
  INDEX_FIELDS,
  INDEX_SCHEMA_VERSION,
  assertSameModel,
  currentSchema,
  planMigration,
  type IndexSchema,
  type MigrationKind,
  type MigrationPlan,
} from "./schema.js";

export { candidateOf, rankBy, tokenise, type Candidate, type IndexRow } from "./row.js";

export { rowStore, type RowStore } from "./partition.js";

export {
  inMemoryLexicalIndex,
  type ExistenceProbe,
  type LexicalIndex,
  type LexicalSearch,
} from "./lexical.js";

export { cosine, inMemoryVectorIndex, type VectorIndex, type VectorSearch } from "./vector.js";
