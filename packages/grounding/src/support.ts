/**
 * The support threshold (PRD 7.3).
 *
 * "The system abstains when the reranked top candidates fall below a support threshold."
 *
 * Three things about that sentence decide this file.
 *
 * **It says *reranked*.** The threshold is on the cross-encoder's score, because it is the only
 * number in the pipeline that means anything across queries — a fused score is a sum of reciprocal
 * ranks and says nothing about whether the passage answers the question, and an index score is
 * corpus-dependent. Thresholding either of those would produce a rule that abstains more on long
 * corpora than on short ones for no reason connected to support.
 *
 * **A bypassed reranker has not judged the support to be poor.** `rerankScore` is null then, not
 * zero, and the policy says what to do rather than letting a comparison against null decide by
 * accident. The default is to proceed: PRD 9.4 requires an unavailable reranker to be *degraded
 * around*, and abstaining on every query while it is down converts a degraded mode into an outage.
 * The cost is that answers served during that window had their support assessed by nothing, which
 * is why the result records it rather than leaving it to be inferred.
 *
 * **The number is not chosen here.** Like PRD 5.2's `k`, a support threshold is selected against
 * the abstention dataset in PRD 8 — where answering an unanswerable query is a scored failure —
 * and until that run exists the value is a placeholder that must not be quoted as tuned. The
 * default is marked, and the decision records which policy produced it.
 */

import type { FusedCandidate } from "@atlasops/retrieval";

export type ThresholdProvenance = "unselected-default" | "selected-on-abstention-set";

export interface SupportPolicy {
  /** The minimum cross-encoder score the best candidate must reach. */
  readonly minRerankScore: number;
  /** What to do when nothing reranked the candidates. See the file header. */
  readonly whenUnranked: "proceed" | "abstain";
  readonly provenance: ThresholdProvenance;
}

export const SUPPORT_DEFAULTS: SupportPolicy = {
  minRerankScore: 0,
  whenUnranked: "proceed",
  provenance: "unselected-default",
};

export type SupportOutcome =
  /** The best candidate cleared the threshold. */
  | "sufficient"
  /** Nothing was retrieved at all. */
  | "no-candidates"
  /** The best candidate scored below the threshold. */
  | "below-threshold"
  /** Nothing reranked the candidates, and the policy proceeds anyway. */
  | "unassessed";

export interface SupportDecision {
  readonly outcome: SupportOutcome;
  /** The best rerank score seen, or null when nothing reranked. */
  readonly best: number | null;
  readonly policy: SupportPolicy;
  readonly abstain: boolean;
}

export function assessSupport(
  candidates: readonly FusedCandidate[],
  policy: SupportPolicy = SUPPORT_DEFAULTS,
): SupportDecision {
  if (candidates.length === 0) {
    return { outcome: "no-candidates", best: null, policy, abstain: true };
  }

  const scores = candidates
    .map((candidate) => candidate.rerankScore)
    .filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return {
      outcome: "unassessed",
      best: null,
      policy,
      abstain: policy.whenUnranked === "abstain",
    };
  }

  const best = Math.max(...scores);
  return {
    outcome: best >= policy.minRerankScore ? "sufficient" : "below-threshold",
    best,
    policy,
    abstain: best < policy.minRerankScore,
  };
}
