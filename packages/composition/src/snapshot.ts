/**
 * The corpus snapshot hash, in one place.
 *
 * PRD 8.1 pins every dataset to the corpus it was labelled against, because "re-ingesting the
 * corpus" is one of the two most effective ways to fake an improvement. That pin is only worth
 * anything if everyone computes the hash the same way.
 *
 * It lived as a private function inside `apps/eval-runner` until the inventory tool needed it too.
 * A second implementation would have agreed until it did not — a different sort order, or counting
 * a deleted source, and every dataset pinned to one hash would fail a check against the other with
 * nothing in the message explaining why. An application may not import another application, so the
 * shared thing is promoted here rather than copied, which is the rule PRD 11.2 states for exactly
 * this case.
 *
 * **Derived from live versions, in identifier order.** So it changes when the corpus changes and
 * not when the crawl order does; a source the corpus has deleted contributes nothing, because a
 * deleted source is not part of what a run could retrieve.
 */

import { contentHashOf, type ContentHash } from "@atlasops/contracts";
import type { CorpusStore } from "@atlasops/corpus";

/** The chunking settings the evaluated corpus is built with. */
export interface CorpusChunking {
  readonly maxTokens: number;
  readonly boundaryDepth: number;
}

/**
 * Shared for the same reason as the hash itself.
 *
 * A chunk identifier is derived from its source version and its ordinal, so chunk boundaries — and
 * therefore every identifier a dataset labels — depend on these two numbers. A tool that inventoried
 * the corpus at a different token budget would produce identifiers the evaluation runner never
 * creates, and the labels would point at nothing while the snapshot hash matched perfectly.
 *
 * Both values carry PRD 14's "unselected" status: they are defaults nobody has tuned on a
 * development split yet, and the artefacts say so.
 */
export const CORPUS_CHUNKING: CorpusChunking = { maxTokens: 256, boundaryDepth: 2 };

export function corpusSnapshotOf(store: CorpusStore): ContentHash {
  const versions = store
    .sources()
    .map((sourceId) => store.liveVersion(sourceId))
    .filter((version) => version !== null)
    .map((version) => `${version.sourceId}\u001f${version.sourceVersionId}`);
  return contentHashOf(versions.join("\n"));
}
