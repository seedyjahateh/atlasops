/**
 * Reciprocal rank fusion (PRD 5.2).
 *
 * Each chunk scores `sum over retrievers of 1 / (k + rank)`. That is the whole algorithm, and its
 * value is in what it refuses to look at: **the scores**.
 *
 * Score interpolation — normalise the cosine similarity and the BM25 score, take a weighted sum —
 * is the obvious alternative and is rejected. BM25 scores are unbounded and corpus-dependent while
 * cosine similarities sit in a narrow model-dependent band, so combining them needs either
 * per-query min-max scaling, which makes one result's score depend on which other documents
 * happened to be retrieved, or a fitted calibration, which is a second model to maintain and
 * revalidate every time either retriever changes.
 *
 * The test file contains a min-max interpolator and a case where two documents with identical raw
 * scores and identical ranks in both arms swap places because a third, lower-ranked document
 * changed. RRF returns the same ordering for both.
 *
 * **The accepted cost is stated in the PRD and is real**: RRF cannot distinguish a dominant
 * first-place result from a marginal one. A query where one retriever is overwhelmingly right is
 * fused as though it were merely slightly right. That discrimination is what the reranker in 5.3
 * restores, which is why the reranker is not optional in the default path even though it is
 * ablatable.
 */

import type { Candidate } from "@atlasops/indexing";

export interface RankedList {
  /** `dense` or `lexical`. Recorded per contribution so an ablation can attribute a result. */
  readonly retriever: string;
  readonly candidates: readonly Candidate[];
}

export interface Contribution {
  readonly retriever: string;
  /** One-based, as the index produced it. */
  readonly rank: number;
}

export interface FusedCandidate extends Candidate {
  /** The fused score. Comparable within one query and meaningless across queries. */
  readonly fusedScore: number;
  /** Which retrievers found it, and where. The evidence an ablation report is built from. */
  readonly contributions: readonly Contribution[];
  /**
   * What the cross-encoder scored this (query, chunk) pair, or null when it did not run.
   *
   * Carried because PRD 7.3 defines its abstention threshold on "the reranked top candidates", and
   * that is the only score in the pipeline that means anything across queries — the fused score is
   * a sum of reciprocal ranks and the index scores are corpus-dependent. **Null is not zero.** A
   * bypassed reranker has not judged the support to be poor; it has not judged it at all, and
   * collapsing the two would turn PRD 9.4's degraded mode into a blanket abstention.
   */
  readonly rerankScore: number | null;
}

export function reciprocalRankFusion(
  lists: readonly RankedList[],
  k: number,
  limit: number,
): readonly FusedCandidate[] {
  const accumulated = new Map<
    string,
    { candidate: Candidate; score: number; contributions: Contribution[] }
  >();

  for (const list of lists) {
    for (const candidate of list.candidates) {
      const existing = accumulated.get(candidate.chunkId);
      const increment = 1 / (k + candidate.rank);

      if (existing === undefined) {
        accumulated.set(candidate.chunkId, {
          candidate,
          score: increment,
          contributions: [{ retriever: list.retriever, rank: candidate.rank }],
        });
        continue;
      }

      existing.score += increment;
      existing.contributions.push({ retriever: list.retriever, rank: candidate.rank });
    }
  }

  return [...accumulated.values()]
    .map((entry) => ({
      ...entry.candidate,
      fusedScore: entry.score,
      rerankScore: null,
      // Sorted, so two runs that queried the arms in a different order produce equal records.
      contributions: [...entry.contributions].sort((a, b) =>
        a.retriever.localeCompare(b.retriever),
      ),
    }))
    .sort((a, b) =>
      // Ties break on the identifier rather than on arrival order: a fused set that depends on
      // which arm answered first is one that changes between runs for no reason anybody can name.
      b.fusedScore === a.fusedScore
        ? a.chunkId.localeCompare(b.chunkId)
        : b.fusedScore - a.fusedScore,
    )
    .slice(0, limit)
    .map((candidate, position) => ({ ...candidate, rank: position + 1 }));
}
