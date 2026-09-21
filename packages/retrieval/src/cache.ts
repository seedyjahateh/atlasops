/**
 * The retrieval result cache (PRD 6.3).
 *
 * "Every cache in the system — embedding cache, retrieval result cache, rerank cache, answer cache
 * — is keyed on a hash of the resolved principal group set in addition to the query. A cache that
 * is keyed on query text alone is a permission bypass with a fast path."
 *
 * The key is built by `governance`'s `permissionedCacheKey`, which has no overload that omits the
 * group set — so the bypass is not a call site somebody forgot to update, it is code that does not
 * compile. The cost is a lower hit rate, which PRD 6.3 accepts explicitly: the alternative is a
 * system whose leak probability rises with its traffic.
 *
 * The configuration is part of the key too. An ablation run with the reranker disabled must not be
 * served a cached result produced with it enabled, or the ablation measures the cache.
 */

import type { ContentHash } from "@atlasops/contracts";
import { permissionedCacheKey } from "@atlasops/governance";

import { configKey, type RetrievalConfig } from "./config.js";
import type { FusedCandidate } from "./fusion.js";
import type { AnalysedQuery } from "./query.js";

export interface RetrievalCache {
  readonly get: (key: string) => readonly FusedCandidate[] | undefined;
  readonly set: (key: string, candidates: readonly FusedCandidate[]) => void;
  /** Required, for the same reason the embedding cache's is: a delete must reach every cache. */
  readonly delete: (key: string) => void;
}

export function retrievalCacheKey(
  query: AnalysedQuery,
  groupSetHash: ContentHash,
  config: RetrievalConfig,
): string {
  return permissionedCacheKey(`retrieval\u001f${configKey(config)}`, query.hash, groupSetHash);
}

export interface RecordingRetrievalCache extends RetrievalCache {
  readonly size: () => number;
  readonly keys: () => readonly string[];
}

export function inMemoryRetrievalCache(): RecordingRetrievalCache {
  const store = new Map<string, readonly FusedCandidate[]>();
  return {
    get: (key: string): readonly FusedCandidate[] | undefined => store.get(key),
    set: (key: string, candidates: readonly FusedCandidate[]): void => {
      store.set(key, candidates);
    },
    delete: (key: string): void => {
      store.delete(key);
    },
    size: (): number => store.size,
    keys: (): readonly string[] => [...store.keys()],
  };
}
