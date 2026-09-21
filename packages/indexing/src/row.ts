/**
 * What an index stores, and what it returns.
 *
 * `IndexRow` looks like `ingest`'s `StoredChunk` and is deliberately a separate type. `ingest` and
 * `indexing` are siblings at layer 4 and neither may import the other (PRD 11.2), which is not an
 * inconvenience to route around — it is what stops a chunker change from rippling into an index
 * adapter. An application wires the two together, and an application is the layer allowed to know
 * about both.
 *
 * A `Candidate` carries its text. Retrieval reranks on it and grounding cites it, and a second
 * lookup to fetch the passage would be a second place a permission check could be forgotten.
 */

import type { AclLabel, Chunk, ChunkId, SourceId, SourceVersionId } from "@atlasops/contracts";

export interface IndexRow {
  readonly chunk: Chunk;
  readonly text: string;
  readonly vector: readonly number[];
}

export interface Candidate {
  readonly chunkId: ChunkId;
  readonly sourceId: SourceId;
  readonly sourceVersionId: SourceVersionId;
  readonly headingPath: readonly string[];
  readonly text: string;
  /**
   * The label this chunk carries.
   *
   * Every candidate is already readable by the principal — the pre-filter saw to that — so this is
   * not how access is decided. It travels because PRD 7.2 requires the verification pass to check
   * independently that "every referenced chunk was readable by this principal", and a check that
   * can only say "it was in the retrieved set" is the same check twice rather than a second one.
   * It also lets PRD 6.6's audit record an authorisation decision per cited chunk.
   */
  readonly acl: AclLabel;
  readonly score: number;
  /** One-based, so a reciprocal-rank fusion in PRD 5.3 has no zero to divide by. */
  readonly rank: number;
}

export function candidateOf(row: IndexRow, score: number, rank: number): Candidate {
  return {
    chunkId: row.chunk.chunkId,
    sourceId: row.chunk.sourceId,
    sourceVersionId: row.chunk.sourceVersionId,
    headingPath: row.chunk.headingPath,
    text: row.text,
    acl: row.chunk.acl,
    score,
    rank,
  };
}

/**
 * Rank a scored set, deterministically.
 *
 * Ties break on chunk identifier rather than on insertion order. A ranking that depends on the
 * order rows happened to be written is one that changes when the corpus is rebuilt, and every
 * evaluation number computed against it moves with it for no reason anybody can name.
 */
export function rankBy(
  scored: readonly { readonly row: IndexRow; readonly score: number }[],
  limit: number,
): readonly Candidate[] {
  return [...scored]
    .sort((a, b) =>
      b.score === a.score
        ? a.row.chunk.chunkId.localeCompare(b.row.chunk.chunkId)
        : b.score - a.score,
    )
    .slice(0, limit)
    .map((entry, position) => candidateOf(entry.row, entry.score, position + 1));
}

/** Lowercased alphanumeric runs. Deliberately simple, and the same on both arms. */
export function tokenise(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}
