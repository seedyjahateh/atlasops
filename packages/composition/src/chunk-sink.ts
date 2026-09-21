/**
 * Where ingestion's output meets retrieval's input (PRD 10, 4.2, 6.2).
 *
 * `ingest` declares a `ChunkSink`; `indexing` owns the lexical and vector indexes; the two are
 * siblings at layer 4 and neither may import the other. This adapter is the join, and this package
 * is the layer allowed to know about both — which is the whole reason the boundary between them is
 * worth having: a change to chunking cannot reach an index adapter except through here.
 *
 * **It keeps its own record as well as writing to the indexes**, and that is not redundancy for its
 * own sake. `indexing` deliberately exposes no unfiltered accessor — `visible(predicate)` is its
 * only read path, so a post-filter cannot be written against it by accident (P7). That decision is
 * worth more than the convenience of reading a row back, so the sink holds the document record that
 * ingestion needs for change detection and the post-delete probe, and the indexes hold the derived,
 * permission-partitioned copy that retrieval searches. A real deployment has exactly this shape: a
 * store of record and indexes built from it.
 *
 * The cost is that a delete has to reach three places, and a purge that updated two of them would
 * be a chunk that retrieval cannot find and ingestion still believes in. `purge` therefore removes
 * from all three and returns what it removed, so the caller can evict the embedding cache too —
 * PRD 4.2's "every cache keyed on it".
 */

import type { AclLabel, ChunkId, SourceId } from "@atlasops/contracts";
import type { VersionRef } from "@atlasops/corpus";
import type { ChunkSink, StoredChunk } from "@atlasops/ingest";
import type { IndexRow, LexicalIndex, VectorIndex } from "@atlasops/indexing";

function asRow(stored: StoredChunk): IndexRow {
  return { chunk: stored.chunk, text: stored.text, vector: stored.vector };
}

export function indexingChunkSink(lexical: LexicalIndex, vector: VectorIndex): ChunkSink {
  const record = new Map<ChunkId, StoredChunk>();

  return {
    async put(chunks: readonly StoredChunk[]): Promise<void> {
      const rows = chunks.map(asRow);
      // The vector index validates the embedding model and the dimension, so it goes first: a
      // mixed-model write should fail before the lexical index and the record have accepted it.
      await vector.upsert(rows);
      await lexical.upsert(rows);
      for (const stored of chunks) record.set(stored.chunk.chunkId, stored);
    },

    async purge(refs: readonly VersionRef[]): Promise<readonly StoredChunk[]> {
      await lexical.purge(refs);
      await vector.purge(refs);

      const wanted = new Set(refs.map((ref) => `${ref.sourceId}\u001f${ref.sourceVersionId}`));
      const removed: StoredChunk[] = [];
      for (const [chunkId, stored] of record) {
        const key = `${stored.chunk.sourceId}\u001f${stored.chunk.sourceVersionId}`;
        if (!wanted.has(key)) continue;
        record.delete(chunkId);
        removed.push(stored);
      }
      return removed;
    },

    async relabel(sourceId: SourceId, acl: AclLabel): Promise<number> {
      const relabelled: StoredChunk[] = [];
      for (const [chunkId, stored] of record) {
        if (stored.chunk.sourceId !== sourceId) continue;
        const next: StoredChunk = { ...stored, chunk: { ...stored.chunk, acl } };
        record.set(chunkId, next);
        relabelled.push(next);
      }

      // Re-upserting is what moves the row between the indexes' per-group posting lists. A
      // relabel that only updated the record would leave a revoked group still able to read it.
      const rows = relabelled.map(asRow);
      await lexical.upsert(rows);
      await vector.upsert(rows);
      return relabelled.length;
    },

    get: (chunkId: ChunkId): Promise<StoredChunk | null> =>
      Promise.resolve(record.get(chunkId) ?? null),

    all: (): Promise<readonly StoredChunk[]> => Promise.resolve([...record.values()]),
  };
}
