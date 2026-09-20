/**
 * Change detection (PRD 4.2).
 *
 * A connector reports what it can see; this file works out what that means against what the corpus
 * holds. It compares hashes and nothing else, so classifying ten thousand unchanged sources costs
 * ten thousand string comparisons rather than ten thousand parses.
 *
 * **A listing declares whether it is complete, and an incomplete one cannot produce deletions.**
 * This is the field that matters most in the file. Deletion is inferred from absence, so a
 * connector that returns an empty page because a token expired, a share was unmounted or a query
 * timed out is one inference away from deleting an entire corpus — and every layer above would be
 * doing exactly what it was told. Making completeness an explicit claim the connector has to make,
 * rather than a property of the array having entries in it, turns that from a silent catastrophe
 * into a run that reports it withheld the deletions and why.
 */

import {
  ValidationError,
  formatSourceVersionId,
  requireContentHash,
  requireInstant,
  type ContentHash,
  type SourceId,
} from "@atlasops/contracts";

import type { CorpusStore } from "./store.js";

export interface ListedSource {
  readonly sourceId: SourceId;
  readonly contentHash: ContentHash;
}

export interface ConnectorListing {
  readonly connector: string;
  readonly observedAt: string;
  readonly sources: readonly ListedSource[];
  /**
   * Whether this is the connector's whole view of what it owns.
   *
   * False for a page, a filtered query, an incremental feed, or any run that hit an error it
   * recovered from. See the file header for why this is not inferred.
   */
  readonly complete: boolean;
}

export interface ChangeSet {
  /** Listed, and the corpus has no record of them. */
  readonly added: readonly SourceId[];
  /** Listed with bytes that are not the current head's. */
  readonly modified: readonly SourceId[];
  /** Listed with the head's bytes. No work to do (PRD 4.2). */
  readonly unchanged: readonly SourceId[];
  /** Live in the corpus, absent from a complete listing. */
  readonly deleted: readonly SourceId[];
  /**
   * Listed, but deleted by order.
   *
   * Not `added`. Upstream still holding a copy is not a reason to undo somebody's deletion, and
   * the crawl should not stop either — it reports these and carries on.
   */
  readonly tombstoned: readonly SourceId[];
  /** True when the listing was incomplete, so absence could not be read as deletion. */
  readonly deletionsWithheld: boolean;
}

export function detectChanges(store: CorpusStore, listing: ConnectorListing): ChangeSet {
  requireInstant(listing.observedAt, "listing.observedAt");

  const listed = new Map<SourceId, ContentHash>();
  listing.sources.forEach((entry, index) => {
    const path = `listing.sources[${String(index)}]`;
    if (listed.has(entry.sourceId)) {
      throw new ValidationError(
        path,
        `${entry.sourceId} is listed twice. Whichever entry lost would decide the source's ` +
          `content by array order, which is not a decision anybody made.`,
      );
    }
    listed.set(entry.sourceId, requireContentHash(entry.contentHash, `${path}.contentHash`));
  });

  const added: SourceId[] = [];
  const modified: SourceId[] = [];
  const unchanged: SourceId[] = [];
  const tombstoned: SourceId[] = [];

  for (const [sourceId, contentHash] of listed) {
    const state = store.state(sourceId);
    if (state === null) added.push(sourceId);
    else if (state.tombstone !== null) tombstoned.push(sourceId);
    else if (state.head === formatSourceVersionId(contentHash)) unchanged.push(sourceId);
    else modified.push(sourceId);
  }

  const deleted: SourceId[] = [];
  if (listing.complete) {
    for (const sourceId of store.sources()) {
      if (listed.has(sourceId)) continue;
      const state = store.state(sourceId);
      if (state === null) continue;
      if (state.tombstone !== null) continue;
      if (state.head === null) continue;
      deleted.push(sourceId);
    }
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    unchanged: unchanged.sort(),
    deleted: deleted.sort(),
    tombstoned: tombstoned.sort(),
    deletionsWithheld: !listing.complete,
  };
}

/** Whether a change set asks for any work at all. */
export function hasWork(changes: ChangeSet): boolean {
  return changes.added.length > 0 || changes.modified.length > 0 || changes.deleted.length > 0;
}
