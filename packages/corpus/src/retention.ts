/**
 * Retention, retrieval eligibility, and temporal reads (PRD 4.1, 4.2).
 *
 * PRD 4.1 accepts index growth proportional to revision count and then immediately bounds it: only
 * the current version is live in the retrieval index, while prior versions stay in the corpus store
 * for audit and temporal evaluation. Those are three populations, not two, and this file names all
 * three — because the third, `purge`, is the one a deletion produces and the one a "keep everything,
 * filter later" design quietly loses.
 *
 * **Eligibility is computed, never stored.** A version is retrievable if it is the head of a source
 * that has not been deleted. Nothing sets an `isDeleted` flag that an index could fail to honour;
 * the question is answered from the pointer and the tombstone every time it is asked. That is what
 * makes PRD 4.2's post-delete probe meaningful rather than a check that a boolean was written.
 */

import {
  requireInstant,
  type SourceId,
  type SourceVersion,
  type SourceVersionId,
} from "@atlasops/contracts";

import type { CorpusStore, VersionRef } from "./store.js";

export interface RetentionPlan {
  /** Eligible for the retrieval index: one version per live source. */
  readonly live: readonly VersionRef[];
  /** Kept in the corpus store for audit and temporal evaluation. Not indexed. */
  readonly retained: readonly VersionRef[];
  /** Must not exist in any index or cache. Produced by deletion, never by age. */
  readonly purge: readonly VersionRef[];
}

function byRef(a: VersionRef, b: VersionRef): number {
  return a.sourceId === b.sourceId
    ? a.sourceVersionId.localeCompare(b.sourceVersionId)
    : a.sourceId.localeCompare(b.sourceId);
}

export function retentionPlan(store: CorpusStore): RetentionPlan {
  const live: VersionRef[] = [];
  const retained: VersionRef[] = [];
  const purge: VersionRef[] = [];

  for (const sourceId of store.sources()) {
    const state = store.state(sourceId);
    if (state === null) continue;

    if (state.tombstone !== null) {
      purge.push(...state.tombstone.purge);
      continue;
    }

    for (const version of state.versions) {
      const ref: VersionRef = { sourceId, sourceVersionId: version.sourceVersionId };
      if (version.sourceVersionId === state.head) live.push(ref);
      else retained.push(ref);
    }
  }

  return { live: live.sort(byRef), retained: retained.sort(byRef), purge: purge.sort(byRef) };
}

/**
 * The corpus-level answer to "may retrieval return this version?".
 *
 * This is the probe PRD 4.2 requires, at this layer. It is not the whole requirement — the same
 * question has to be asked of the lexical index, the vector index and every cache keyed on the
 * chunk, which is `indexing`'s and `ingest`'s half — but it is the authority those layers are
 * reconciled against, and a version this returns false for must be absent from all of them.
 */
export function isRetrievable(store: CorpusStore, ref: VersionRef): boolean {
  const state = store.state(ref.sourceId);
  if (state === null) return false;
  if (state.tombstone !== null) return false;
  return state.head === ref.sourceVersionId;
}

/**
 * What this source held at a given instant — "what did the policy say in March".
 *
 * Reconstructed from the recorded head movements rather than by sorting versions by date, because
 * the two disagree exactly when it matters: a version observed late but effective earlier, or a
 * rollback, would put the wrong record in March under a date sort. The head log is a record of what
 * was actually live.
 *
 * The label returned is the one that was in force at that instant, which is the honest answer to an
 * audit question. **It is therefore not an authorisation path.** A live request is served from
 * `liveVersion` and the current label; using this function to decide what somebody may read now
 * would honour a permission that has since been revoked.
 *
 * A deleted source returns null at every instant. PRD 4.2 is explicit that a governed system cannot
 * have a "mostly deleted" document, and a temporal read that still answers is exactly that.
 */
export function versionAsOf(
  store: CorpusStore,
  sourceId: SourceId,
  instant: string,
): SourceVersion | null {
  const at = Date.parse(requireInstant(instant, "instant"));
  const state = store.state(sourceId);
  if (state === null) return null;
  if (state.tombstone !== null) return null;

  let head: SourceVersionId | null = null;
  for (const move of state.headLog) {
    if (Date.parse(move.at) > at) break;
    head = move.to;
  }
  if (head === null) return null;

  const frozen = state.versions.find((version) => version.sourceVersionId === head);
  if (frozen === undefined) return null;

  let acl = state.acl;
  for (const revision of state.aclLog) {
    if (Date.parse(revision.at) > at) break;
    acl = revision.acl;
  }

  return { ...frozen, acl };
}
