/**
 * The four dataset shapes PRD 8.1 enumerates.
 *
 * Each carries the principal as well as the query. That is not optional bookkeeping: every metric
 * in this system is a function of *who asked*, because the candidate set is. A relevance label that
 * did not name a principal would be a label for whichever principal the harness happened to use,
 * and the permission probe set in particular exists precisely to be run as a principal who must not
 * see the obvious answer.
 */

import type { DatasetItem } from "./dataset.js";

/** PRD 8.1 item 1: graded relevance judgments over chunk identifiers. */
export interface RelevanceItem extends DatasetItem {
  readonly query: string;
  readonly principal: string;
  /**
   * Chunk identifier to graded relevance. Zero and absent both mean irrelevant.
   *
   * Graded rather than binary because PRD 8.2 asks for nDCG, and nDCG over binary labels cannot
   * distinguish a run that put the definitive passage first from one that put a passing mention
   * there — which is most of what reranking is for.
   */
  readonly judgments: Readonly<Record<string, number>>;
  /** Which adversarial subpopulation this belongs to, per PRD 8.1 item 1. */
  readonly subpopulation?: string;
}

/** PRD 8.1 item 2: queries with the chunks that legitimately support them. */
export interface GroundedAnswerItem extends DatasetItem {
  readonly query: string;
  readonly principal: string;
  readonly referenceAnswer: string;
  readonly supportingChunks: readonly string[];
  /**
   * The human-labelled calibration subset PRD 8.3 requires.
   *
   * Present on a subset, not on every item — labelling all of them by hand is the cost the judge
   * exists to avoid. Its presence is what lets judge-human agreement be reported alongside every
   * judged metric, and `judgedMetrics` refuses to return a judged score when no item carries one.
   */
  readonly humanJudgement?: {
    readonly supported: boolean;
    readonly contradicted: boolean;
  };
}

/** PRD 8.1 item 3: unanswerable and under-supported queries. */
export interface AbstentionItem extends DatasetItem {
  readonly query: string;
  readonly principal: string;
  /** What a correct system does. Answering when this is true is a scored failure (PRD 7.3). */
  readonly shouldAbstain: boolean;
  readonly why: string;
}

/** PRD 8.1 item 4: query/principal pairs where a correct system returns nothing or less. */
export interface PermissionProbeItem extends DatasetItem {
  readonly query: string;
  readonly principal: string;
  /** Chunks this principal must never see — in a candidate set, a prompt, or a citation. */
  readonly forbiddenChunks: readonly string[];
  /**
   * Which adversarial subpopulation this probe belongs to.
   *
   * PRD 8.1 item 4 folds the prompt-injection corpus from 6.5 into this set, and PRD 12 item 3
   * requires the injection subset's result to be reported separately from the whole. A leak count
   * of zero over a set that happens to contain no injection probe is a different claim from a
   * leak count of zero over one that does, and only the marker tells them apart.
   */
  readonly subpopulation?: string;
  /**
   * Whether this principal may learn that withheld material exists.
   *
   * False for a `hidden` source. The system may then say only what it says when nothing was found
   * at all, and saying more is counted as an existence disclosure even though no content leaked.
   */
  readonly existenceDisclosable: boolean;
}
