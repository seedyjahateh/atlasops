/**
 * The vector index adapter (PRD 5.1, 6.2, 4.4).
 *
 * The same group-partitioned store as the lexical arm, for the same reason: PRD 6.2 requires the
 * permission predicate to be applied by **both** indexes during candidate generation, and an
 * approximate-nearest-neighbour search that filters afterwards is the canonical way this gets built
 * and the canonical way it leaks.
 *
 * It is worth naming what a real ANN index makes harder here. Exact search over a filtered subset
 * is trivially correct; a graph or IVF index has to support filtered traversal, and the usual
 * shortcut — over-fetch and then drop — reintroduces the truncation leak PRD 6.2 describes, because
 * the number of results that survive tells the caller how much they were not allowed to see. Any
 * adapter that replaces this one has to answer that, and this file exists partly to state the
 * question it must answer.
 *
 * The mixed-model guard runs on every query and every write. PRD 4.4 is unambiguous that an index
 * holding vectors from two models is silently broken, and silence is the whole problem: the
 * comparison succeeds and returns a ranking.
 */

import type { ChunkId, EmbeddingModelRef } from "@atlasops/contracts";
import type { VersionRef } from "@atlasops/corpus";

import { rowStore } from "./partition.js";
import type { CompiledPredicate } from "./predicate.js";
import { rankBy, type Candidate, type IndexRow } from "./row.js";
import { assertSameModel, type IndexSchema } from "./schema.js";

export interface VectorSearch {
  readonly vector: readonly number[];
  /** The model that produced `vector`. Checked against the index's own (PRD 4.4). */
  readonly embedding: EmbeddingModelRef;
  readonly predicate: CompiledPredicate;
  readonly limit: number;
}

export interface VectorIndex {
  readonly schema: IndexSchema;
  readonly upsert: (rows: readonly IndexRow[]) => Promise<void>;
  readonly purge: (refs: readonly VersionRef[]) => Promise<readonly IndexRow[]>;
  readonly search: (request: VectorSearch) => Promise<readonly Candidate[]>;
  readonly lastScan: () => readonly ChunkId[];
  readonly size: () => number;
}

/**
 * Cosine similarity, computed as a dot product over normalised vectors.
 *
 * It normalises rather than assuming unit length. The in-repo fake embedder produces unit vectors,
 * so assuming it would pass every test here and then quietly mis-rank against a provider that does
 * not — a defect that only appears once the fake is swapped for the thing it stands in for.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }

  const magnitude = Math.sqrt(left) * Math.sqrt(right);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/**
 * A method typed as returning a promise must reject, never throw.
 *
 * The mixed-model guard is synchronous, and a caller that writes `index.search(…).catch(…)` would
 * crash on the synchronous path instead of handling the error it explicitly asked to handle. An API
 * that sometimes throws and sometimes rejects is one whose callers get the error handling wrong
 * exactly on the branch that matters.
 */
function rejected(error: unknown): Promise<never> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

export function inMemoryVectorIndex(schema: IndexSchema): VectorIndex {
  const store = rowStore();

  return {
    schema,

    upsert(rows: readonly IndexRow[]): Promise<void> {
      try {
        for (const row of rows) {
          assertSameModel(schema, row.chunk.embedding, `chunk ${row.chunk.chunkId}`);
          if (row.vector.length !== schema.embedding.dimension) {
            throw new RangeError(
              `chunk ${row.chunk.chunkId} carries a ${String(row.vector.length)}-dimension vector ` +
                `for a ${String(schema.embedding.dimension)}-dimension index`,
            );
          }
        }
      } catch (error) {
        return rejected(error);
      }

      // Validated in full before anything is written: a batch that fails halfway would leave the
      // index holding part of a write nobody can name.
      store.upsert(rows);
      return Promise.resolve();
    },

    purge: (refs: readonly VersionRef[]): Promise<readonly IndexRow[]> =>
      Promise.resolve(store.purge(refs)),

    search(request: VectorSearch): Promise<readonly Candidate[]> {
      try {
        assertSameModel(schema, request.embedding, "the query vector");
      } catch (error) {
        return rejected(error);
      }

      const visible = store.visible(request.predicate);
      const scored = visible.map((row) => ({ row, score: cosine(request.vector, row.vector) }));

      // Negative similarity means the passage points away from the query. Keeping it to fill the
      // limit puts material in the candidate set that the query is evidence against.
      return Promise.resolve(
        rankBy(
          scored.filter((entry) => entry.score > 0),
          request.limit,
        ),
      );
    },

    lastScan: (): readonly ChunkId[] => store.lastScan(),
    size: (): number => store.size(),
  };
}
