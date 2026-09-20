/**
 * Where chunks go, and the probe that proves they left (PRD 4.2).
 *
 * This is `ingest`'s own port, plus the in-memory implementation every test above uses. The real
 * indexes live in `indexing` — but `ingest` and `indexing` are siblings at layer 4 and neither may
 * import the other (PRD 11.2), so nothing there implements this interface. An application adapts
 * `indexing`'s lexical and vector indexes to it, because an application is the layer allowed to
 * know about both. The shape is dictated by one sentence of PRD 4.2: "a delete must remove the
 * chunk from the lexical index, the vector index, and every cache keyed on it, and a post-delete
 * probe query must not return it."
 *
 * Three consequences, all visible in the interface:
 *
 * **`purge` returns what it removed**, rather than a count. The pipeline has to evict the embedding
 * cache afterwards, and the cache is keyed on chunk text — so the purge has to hand back the text
 * it deleted, or nothing downstream can find the entries to forget.
 *
 * **`get` exists purely to be the post-delete probe.** It is not how retrieval reads; retrieval
 * ranks. A store with no way to ask "is this specific chunk still here" cannot be shown to have
 * honoured a deletion, and PRD 4.2 asks exactly that question.
 *
 * **`relabel` changes an access label without touching a vector.** ADR 0003: a permission change
 * produces no new version, so re-embedding on a relabel would spend the dominant cost of ingestion
 * on content that did not change. It is a separate operation because it has a separate cost.
 */

import type { AclLabel, Chunk, ChunkId, SourceId } from "@atlasops/contracts";
import type { VersionRef } from "@atlasops/corpus";

export interface StoredChunk {
  readonly chunk: Chunk;
  /** The passage itself. A lexical index holds it, and a purge needs it to evict the cache. */
  readonly text: string;
  readonly vector: readonly number[];
}

export interface ChunkSink {
  readonly put: (chunks: readonly StoredChunk[]) => Promise<void>;
  /** Remove every chunk belonging to these versions, and report what was removed. */
  readonly purge: (refs: readonly VersionRef[]) => Promise<readonly StoredChunk[]>;
  /** Replace the access label on a source's stored chunks. No vector is touched. */
  readonly relabel: (sourceId: SourceId, acl: AclLabel) => Promise<number>;
  /** The post-delete probe. Null means the chunk is not there. */
  readonly get: (chunkId: ChunkId) => Promise<StoredChunk | null>;
  readonly all: () => Promise<readonly StoredChunk[]>;
}

export function inMemoryChunkSink(): ChunkSink {
  const stored = new Map<ChunkId, StoredChunk>();

  return {
    put: (chunks: readonly StoredChunk[]): Promise<void> => {
      for (const entry of chunks) stored.set(entry.chunk.chunkId, entry);
      return Promise.resolve();
    },

    purge: (refs: readonly VersionRef[]): Promise<readonly StoredChunk[]> => {
      const wanted = new Set(refs.map((ref) => `${ref.sourceId}\u001f${ref.sourceVersionId}`));
      const removed: StoredChunk[] = [];

      for (const [chunkId, entry] of stored) {
        const key = `${entry.chunk.sourceId}\u001f${entry.chunk.sourceVersionId}`;
        if (!wanted.has(key)) continue;
        stored.delete(chunkId);
        removed.push(entry);
      }

      return Promise.resolve(removed);
    },

    relabel: (sourceId: SourceId, acl: AclLabel): Promise<number> => {
      let changed = 0;
      for (const [chunkId, entry] of stored) {
        if (entry.chunk.sourceId !== sourceId) continue;
        stored.set(chunkId, { ...entry, chunk: { ...entry.chunk, acl } });
        changed += 1;
      }
      return Promise.resolve(changed);
    },

    get: (chunkId: ChunkId): Promise<StoredChunk | null> =>
      Promise.resolve(stored.get(chunkId) ?? null),

    all: (): Promise<readonly StoredChunk[]> => Promise.resolve([...stored.values()]),
  };
}

/**
 * A sink whose writes fail, for exercising isolation.
 *
 * The interesting failure is not that a write can fail — it is that one source's failed write must
 * not take the rest of the batch with it, and that the corpus must not end up claiming a version is
 * live when the index never received it.
 */
export function failingChunkSink(reason = "index unavailable"): ChunkSink {
  const inner = inMemoryChunkSink();
  return {
    ...inner,
    put: (): Promise<void> => Promise.reject(new Error(reason)),
  };
}
