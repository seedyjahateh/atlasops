/**
 * The group-partitioned row store — where the pre-filter actually lives (PRD 6.2).
 *
 * Rows are held in a posting list per readable group. Candidate generation walks the union of the
 * posting lists for the groups in the compiled predicate, and **nothing else is ever looked up**. A
 * row the principal may not read is not scored and rejected, not fetched and discarded: it is never
 * reached, because the only read path into the store takes a predicate.
 *
 * That is the difference between implementing PRD 6.2 and claiming to. A store with a `rows()`
 * accessor and a filter applied afterwards satisfies the same tests on the same day and drifts the
 * first time somebody adds a code path that forgets the filter. Here there is no unfiltered
 * accessor to forget — `visible` is the only way in, and it cannot be called without a predicate.
 *
 * `lastScan` records which rows were touched. It is an operational statistic any index reports, and
 * it is also the evidence: a test can assert that a search examined no row the principal cannot
 * read, which is a claim about the implementation rather than about its output.
 *
 * A row whose ACL lists no groups appears in no posting list and is therefore unreachable by
 * everybody. PRD 6.1's "empty means nobody" ends up being true by construction.
 */

import type { ChunkId, GroupId } from "@atlasops/contracts";
import type { VersionRef } from "@atlasops/corpus";

import { groupsToVisit, type CompiledPredicate } from "./predicate.js";
import type { IndexRow } from "./row.js";

export interface RowStore {
  readonly upsert: (rows: readonly IndexRow[]) => void;
  readonly purge: (refs: readonly VersionRef[]) => readonly IndexRow[];
  /** The only read path. Takes a predicate because there is no unfiltered one. */
  readonly visible: (predicate: CompiledPredicate) => readonly IndexRow[];
  /**
   * Rows the predicate excludes.
   *
   * Exists solely for PRD 6.4's existence probe, and is named to be conspicuous in review. Its
   * caller must never let a row from here reach a candidate set, a score, a prompt or a cache —
   * only a count and an existence policy.
   */
  readonly withheldForExistenceProbe: (predicate: CompiledPredicate) => readonly IndexRow[];
  /** The chunks touched by the last `visible` call. An operational statistic, and the evidence. */
  readonly lastScan: () => readonly ChunkId[];
  readonly size: () => number;
}

export function rowStore(): RowStore {
  const rows = new Map<ChunkId, IndexRow>();
  const postings = new Map<GroupId, Set<ChunkId>>();
  let scan: ChunkId[] = [];

  function unlink(chunkId: ChunkId, row: IndexRow): void {
    for (const group of row.chunk.acl.readableBy) postings.get(group)?.delete(chunkId);
  }

  return {
    upsert(incoming: readonly IndexRow[]): void {
      for (const row of incoming) {
        const chunkId = row.chunk.chunkId;
        const existing = rows.get(chunkId);
        // A relabelled row must leave its old posting lists, or a revoked group keeps reading it.
        if (existing !== undefined) unlink(chunkId, existing);

        rows.set(chunkId, row);
        for (const group of row.chunk.acl.readableBy) {
          const list = postings.get(group) ?? new Set<ChunkId>();
          list.add(chunkId);
          postings.set(group, list);
        }
      }
    },

    purge(refs: readonly VersionRef[]): readonly IndexRow[] {
      const wanted = new Set(refs.map((ref) => `${ref.sourceId}\u001f${ref.sourceVersionId}`));
      const removed: IndexRow[] = [];

      for (const [chunkId, row] of rows) {
        const key = `${row.chunk.sourceId}\u001f${row.chunk.sourceVersionId}`;
        if (!wanted.has(key)) continue;
        unlink(chunkId, row);
        rows.delete(chunkId);
        removed.push(row);
      }

      return removed;
    },

    visible(predicate: CompiledPredicate): readonly IndexRow[] {
      const seen = new Set<ChunkId>();
      const visible: IndexRow[] = [];

      for (const group of groupsToVisit(predicate.filter)) {
        for (const chunkId of postings.get(group) ?? []) {
          // Deduplicated: a chunk readable by two of the principal's groups is one candidate, and
          // one document for the term statistics that follow.
          if (seen.has(chunkId)) continue;
          seen.add(chunkId);
          const row = rows.get(chunkId);
          if (row !== undefined) visible.push(row);
        }
      }

      scan = [...seen];
      return visible;
    },

    withheldForExistenceProbe(predicate: CompiledPredicate): readonly IndexRow[] {
      const readable = new Set<ChunkId>();
      for (const group of groupsToVisit(predicate.filter)) {
        for (const chunkId of postings.get(group) ?? []) readable.add(chunkId);
      }
      return [...rows.entries()]
        .filter(([chunkId]) => !readable.has(chunkId))
        .map(([, row]) => row);
    },

    lastScan: (): readonly ChunkId[] => [...scan],
    size: (): number => rows.size,
  };
}
