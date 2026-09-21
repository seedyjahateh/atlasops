/**
 * Retrieval metrics (PRD 8.2, row 1).
 *
 * recall@k, nDCG@10, MRR, and per-retriever contribution, computed from graded relevance labels
 * over a ranked list of chunk identifiers.
 *
 * **nDCG is graded, not binary.** The gain is `2^grade - 1`, so a passage labelled 3 is worth
 * meaningfully more than one labelled 1 rather than equally much. That is the whole reason PRD 8.1
 * asks for graded judgments: binary nDCG cannot distinguish a run that put the definitive passage
 * first from one that put a passing mention there, and telling those apart is most of what
 * reranking is for. A test holds two runs that binary nDCG scores identically and graded nDCG does
 * not.
 *
 * **The ideal ranking comes from every label, not from what was retrieved.** An IDCG computed over
 * the retrieved set only would score a run that missed the best passage entirely as perfect,
 * because the best thing it found would be the best thing it was measured against.
 */

import type { FusedCandidate } from "@atlasops/retrieval";

import { metricResult, type MetricResult, type PerQueryScore } from "./metric.js";
import type { RelevanceItem } from "./shapes.js";

/** One query's outcome: what the system returned, in order. */
export interface RankedOutcome {
  readonly itemId: string;
  readonly ranked: readonly string[];
}

function relevantChunks(item: RelevanceItem): readonly string[] {
  return Object.entries(item.judgments)
    .filter(([, grade]) => grade > 0)
    .map(([chunkId]) => chunkId);
}

export function recallAt(
  k: number,
  items: readonly RelevanceItem[],
  outcomes: readonly RankedOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.ranked]));

  const perQuery: PerQueryScore[] = items.map((item) => {
    const relevant = new Set(relevantChunks(item));
    if (relevant.size === 0) {
      // A query with no relevant chunk labelled cannot have its recall measured. Scoring it 1
      // would quietly reward a run for a query nobody labelled.
      return { itemId: item.id, value: 0 };
    }
    const found = (byId.get(item.id) ?? []).slice(0, k).filter((chunkId) => relevant.has(chunkId));
    return { itemId: item.id, value: found.length / relevant.size };
  });

  return metricResult(`recall@${String(k)}`, perQuery);
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce(
    (sum, grade, position) => sum + (Math.pow(2, grade) - 1) / Math.log2(position + 2),
    0,
  );
}

export function ndcgAt(
  k: number,
  items: readonly RelevanceItem[],
  outcomes: readonly RankedOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.ranked]));

  const perQuery: PerQueryScore[] = items.map((item) => {
    const ranked = (byId.get(item.id) ?? []).slice(0, k);
    const observed = ranked.map((chunkId) => item.judgments[chunkId] ?? 0);

    // Over every label, not over what was retrieved. See the file header.
    const ideal = Object.values(item.judgments)
      .filter((grade) => grade > 0)
      .sort((a, b) => b - a)
      .slice(0, k);

    const idcg = discountedGain(ideal);
    return { itemId: item.id, value: idcg === 0 ? 0 : discountedGain(observed) / idcg };
  });

  return metricResult(`nDCG@${String(k)}`, perQuery);
}

export function meanReciprocalRank(
  items: readonly RelevanceItem[],
  outcomes: readonly RankedOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.ranked]));

  const perQuery: PerQueryScore[] = items.map((item) => {
    const relevant = new Set(relevantChunks(item));
    const position = (byId.get(item.id) ?? []).findIndex((chunkId) => relevant.has(chunkId));
    return { itemId: item.id, value: position === -1 ? 0 : 1 / (position + 1) };
  });

  return metricResult("MRR", perQuery);
}

/** One query's fused candidates, carrying which arm found each. */
export interface FusedOutcome {
  readonly itemId: string;
  readonly candidates: readonly FusedCandidate[];
}

/**
 * What each retriever contributed (PRD 8.2, row 1).
 *
 * Per query, the share of the relevant chunks that were found at all which this arm found. A chunk
 * both arms found counts for both, because the question the metric answers is "what would we lose
 * by removing this arm", and the answer for a chunk the other arm also found is "nothing". The
 * shares therefore do not sum to one, and that is the honest shape — an ablation run (P10b) is what
 * measures the marginal contribution, and this is the cheap descriptive statistic beside it.
 */
export function perRetrieverContribution(
  items: readonly RelevanceItem[],
  outcomes: readonly FusedOutcome[],
): readonly MetricResult[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.candidates]));
  const retrievers = [
    ...new Set(
      outcomes.flatMap((outcome) =>
        outcome.candidates.flatMap((candidate) =>
          candidate.contributions.map((entry) => entry.retriever),
        ),
      ),
    ),
  ].sort();

  return retrievers.map((retriever) => {
    const perQuery: PerQueryScore[] = items.map((item) => {
      const relevant = new Set(relevantChunks(item));
      const candidates = byId.get(item.id) ?? [];
      const foundRelevant = candidates.filter((candidate) => relevant.has(candidate.chunkId));
      if (foundRelevant.length === 0) return { itemId: item.id, value: 0 };

      const mine = foundRelevant.filter((candidate) =>
        candidate.contributions.some((entry) => entry.retriever === retriever),
      );
      return { itemId: item.id, value: mine.length / foundRelevant.length };
    });

    return metricResult(`contribution:${retriever}`, perQuery);
  });
}
