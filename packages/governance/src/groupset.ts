/**
 * The resolved group-set hash, and the cache keys built from it (PRD 6.3).
 *
 * "A cache that is keyed on query text alone is a permission bypass with a fast path." The fix is
 * mechanical: every cache key in the system is derived here, and this module has no way to produce
 * one without a group set. The cost is a lower hit rate, which is the correct trade — the
 * alternative is a system whose leak probability rises with its traffic.
 *
 * The one exception PRD 6.3 allows is the embedding cache: keyed on chunk text hash, never returns
 * chunk content to a caller, and therefore sits below the permission boundary by construction. It
 * has its own function here so that the exception is explicit and greppable rather than being a
 * call site that forgot to pass a principal.
 */

import { contentHashOf, type ContentHash, type GroupId } from "@atlasops/contracts";

import { normaliseGroups } from "./principal.js";

/**
 * Stable across orderings and duplicates.
 *
 * The separator matters. Joining on a character that can appear inside an identifier lets
 * `["grp_a-b"]` and `["grp_a", "b"]` hash alike, which is a boundary collision rather than a
 * cosmetic one — so the separator is a unit-separator control character, which the identifier
 * grammar in contracts cannot contain.
 */
export function groupSetHash(groups: Iterable<GroupId>): ContentHash {
  return contentHashOf(normaliseGroups(groups).join("\u001f"));
}

/** A cache key for anything that can return chunk content: retrieval, rerank, answers. */
export function permissionedCacheKey(
  namespace: string,
  queryHash: ContentHash,
  groups: ContentHash,
): string {
  return `${namespace}\u001f${queryHash}\u001f${groups}`;
}

/**
 * The embedding-cache exception from PRD 6.3.
 *
 * Deliberately a separate function with a name that says what it is, so that using it for anything
 * that returns retrievable content is a visible mistake in review rather than an omitted argument.
 */
export function computeCacheKey(namespace: string, contentHash: ContentHash): string {
  return `${namespace}\u001f${contentHash}`;
}
