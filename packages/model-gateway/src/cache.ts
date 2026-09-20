/**
 * The embedding cache.
 *
 * PRD 6.3 names this as the one cache that may sit below the permission boundary: it is keyed on
 * chunk text and never returns chunk content to a caller, so it is a compute cache rather than a
 * retrieval cache. It therefore takes no principal, and deliberately has no parameter where one
 * could be passed.
 *
 * **The key includes the model and its dimension.** Without that, changing embedding model returns
 * the previous model's vectors from cache — which is the mixed-model index PRD 4.4 calls silently
 * broken, arriving through the fastest path in the system rather than through a migration somebody
 * would have reviewed.
 */

import { contentHashOf, type EmbeddingModelRef } from "@atlasops/contracts";

export interface EmbeddingCache {
  readonly get: (key: string) => readonly number[] | undefined;
  readonly set: (key: string, vector: readonly number[]) => void;
}

export function embeddingCacheKey(model: EmbeddingModelRef, text: string): string {
  return `${model.id}\u001f${String(model.dimension)}\u001f${contentHashOf(text)}`;
}

export interface RecordingEmbeddingCache extends EmbeddingCache {
  readonly size: () => number;
}

/**
 * Unbounded, on purpose, and only appropriate for a process-scoped ingestion run.
 *
 * A real deployment wants an eviction policy and a shared store; this exists so that the ingestion
 * worker's "do not re-embed an unchanged chunk" requirement (PRD 4.2) has something to hold the
 * result in, and so tests can assert hit behaviour without a service. Naming the limitation here
 * rather than shipping a silent memory leak dressed as a cache.
 */
export function inMemoryEmbeddingCache(): RecordingEmbeddingCache {
  const store = new Map<string, readonly number[]>();
  return {
    get: (key: string): readonly number[] | undefined => store.get(key),
    set: (key: string, vector: readonly number[]): void => {
      store.set(key, vector);
    },
    size: (): number => store.size,
  };
}
