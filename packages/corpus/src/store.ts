/**
 * The corpus store (PRD 4.1, 4.2).
 *
 * Three properties, each of which the rest of the system leans on.
 *
 * **A version is immutable once written.** Observing the same bytes again never rewrites the stored
 * record — not its observation time, not its `supersedes` pointer, not its label. Re-ingestion is
 * therefore idempotent by construction rather than by the pipeline happening to be careful, which
 * is what makes PRD 4.5's determinism target testable at all.
 *
 * **Rollback is a pointer move.** A version's identity is the hash of its bytes, so a source that
 * reverts to earlier content produces an identifier the store already holds. Writing a second copy
 * would need a different `supersedes` on an immutable record — a contradiction — so the store keeps
 * a head pointer and a log of head movements instead of a linked list. PRD 4.1 calls rollback a
 * pointer move; here it literally is one.
 *
 * **An access label is not a version.** Identity is bytes alone, so a permission change produces no
 * new version — and a permission change must take effect immediately rather than waiting for
 * somebody to edit the document. The label therefore has its own log, the frozen record keeps the
 * label observed when the bytes first arrived, and the live read path re-labels with the current
 * one. ADR 0003 records this and the deduplication hazard that follows from it.
 */

import {
  AtlasOpsError,
  requireInstant,
  type AclLabel,
  type PrincipalId,
  type SourceId,
  type SourceVersion,
  type SourceVersionId,
} from "@atlasops/contracts";
import type { Principal } from "@atlasops/governance";

import {
  observedAcl,
  observedVersionId,
  versionFrom,
  type SourceObservation,
} from "./observation.js";

/**
 * A version, named by the source that holds it.
 *
 * Version identifiers are content-addressed, so two sources holding byte-identical content share
 * one. Every reference out of this package therefore carries the source as well — see ADR 0003.
 */
export interface VersionRef {
  readonly sourceId: SourceId;
  readonly sourceVersionId: SourceVersionId;
}

export type HeadMoveReason = "observed" | "restored" | "deleted" | "reinstated";

/** Every movement of a source's live pointer, in order. The provenance chain (PRD 4.1). */
export interface HeadMove {
  readonly at: string;
  readonly from: SourceVersionId | null;
  readonly to: SourceVersionId | null;
  readonly reason: HeadMoveReason;
}

export interface AclRevision {
  readonly at: string;
  readonly acl: AclLabel;
}

/** A deletion or reinstatement, and who is answerable for it. */
export interface CorpusOrder {
  readonly sourceId: SourceId;
  readonly at: string;
  readonly orderedBy: Principal;
  /** Required and non-empty: an unexplained deletion is not an auditable one. */
  readonly reason: string;
}

export interface Tombstone {
  readonly sourceId: SourceId;
  readonly deletedAt: string;
  readonly orderedBy: PrincipalId;
  readonly reason: string;
  /**
   * Every version ever written for this source.
   *
   * PRD 4.2 requires a delete to reach the lexical index, the vector index and every cache keyed on
   * the content — not just the version that happened to be live. This list is what the layers above
   * purge; chunk identifiers are derivable from it, so nothing has to be enumerated separately.
   */
  readonly purge: readonly VersionRef[];
}

export type AppendOutcome =
  /** New bytes. A version was written and the head moved to it. */
  | "created"
  /** The head already holds these bytes and this label. Nothing was written. */
  | "unchanged"
  /** These bytes are a version the store already holds. The head moved back to it. */
  | "restored"
  /** The bytes are unchanged; the access label is not. No version, new label. */
  | "acl-changed";

export interface AppendResult {
  readonly outcome: AppendOutcome;
  /** The live version after the append, carrying the current label rather than the frozen one. */
  readonly version: SourceVersion;
}

export interface SourceState {
  readonly sourceId: SourceId;
  readonly head: SourceVersionId | null;
  /** The label in force now, which is not necessarily the one on the head's frozen record. */
  readonly acl: AclLabel;
  /** Frozen records, in the order they were first written. */
  readonly versions: readonly SourceVersion[];
  readonly headLog: readonly HeadMove[];
  readonly aclLog: readonly AclRevision[];
  readonly tombstone: Tombstone | null;
}

export interface CorpusStore {
  readonly append: (observation: SourceObservation) => AppendResult;
  readonly delete: (order: CorpusOrder) => Tombstone;
  readonly reinstate: (order: CorpusOrder) => SourceState;
  readonly state: (sourceId: SourceId) => SourceState | null;
  /** Every source the store has ever held, deleted ones included. Sorted. */
  readonly sources: () => readonly SourceId[];
  /** The head version with the current label, or null when there is none or it was deleted. */
  readonly liveVersion: (sourceId: SourceId) => SourceVersion | null;
  /** A frozen record, as written. Keyed by source because identifiers are content-addressed. */
  readonly version: (ref: VersionRef) => SourceVersion | null;
}

const DENY_ALL: AclLabel = { readableBy: [], existence: "hidden" };

function sameAcl(a: AclLabel, b: AclLabel): boolean {
  if (a.existence !== b.existence) return false;
  if (a.readableBy.length !== b.readableBy.length) return false;
  const left = [...a.readableBy].sort();
  const right = [...b.readableBy].sort();
  return left.every((group, index) => group === right[index]);
}

interface Entry {
  readonly sourceId: SourceId;
  readonly versions: Map<SourceVersionId, SourceVersion>;
  /** First-write order, which is the only order that is stable under rollback. */
  readonly written: SourceVersionId[];
  readonly headLog: HeadMove[];
  readonly aclLog: AclRevision[];
  head: SourceVersionId | null;
  tombstone: Tombstone | null;
}

function currentAcl(entry: Entry): AclLabel {
  return entry.aclLog.at(-1)?.acl ?? DENY_ALL;
}

function liveRecord(entry: Entry): SourceVersion | null {
  if (entry.tombstone !== null || entry.head === null) return null;
  const frozen = entry.versions.get(entry.head);
  if (frozen === undefined) return null;
  return { ...frozen, acl: currentAcl(entry) };
}

function snapshot(entry: Entry): SourceState {
  return {
    sourceId: entry.sourceId,
    head: entry.head,
    acl: currentAcl(entry),
    versions: entry.written.flatMap((id) => {
      const version = entry.versions.get(id);
      return version === undefined ? [] : [version];
    }),
    headLog: [...entry.headLog],
    aclLog: [...entry.aclLog],
    tombstone: entry.tombstone,
  };
}

function requireOrder(order: CorpusOrder, verb: string): string {
  if (order.reason.trim().length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${verb} ${order.sourceId} was ordered with no stated reason. A deletion nobody has to ` +
        `justify is a deletion nobody can review.`,
      "order.reason",
    );
  }
  return requireInstant(order.at, "order.at");
}

/**
 * The deterministic in-repo store.
 *
 * In memory rather than backed by a database, and that is the point for now: the semantics above —
 * immutability, pointer-move rollback, label revision, hard deletion — are the contract, and they
 * are tested here without a container. A persistent implementation satisfies this same interface
 * and is graded by this same test file.
 */
export function inMemoryCorpusStore(): CorpusStore {
  const entries = new Map<SourceId, Entry>();

  function entryFor(sourceId: SourceId, verb: string): Entry {
    const entry = entries.get(sourceId);
    if (entry === undefined) {
      throw new AtlasOpsError(
        "VALIDATION",
        `cannot ${verb} ${sourceId}: the corpus holds no record of it. Succeeding quietly here ` +
          `would turn a mistyped identifier into a document that was never actually removed.`,
        "order.sourceId",
      );
    }
    return entry;
  }

  /** The head record, when the caller has already established there is one. */
  function liveOrFail(entry: Entry): SourceVersion {
    const version = liveRecord(entry);
    if (version === null) {
      throw new AtlasOpsError(
        "VALIDATION",
        `${entry.sourceId} has a head pointer with no record behind it`,
      );
    }
    return version;
  }

  return {
    append(observation: SourceObservation): AppendResult {
      const versionId = observedVersionId(observation);
      const entry = entries.get(observation.sourceId);
      const tombstone = entry?.tombstone ?? null;

      if (tombstone !== null) {
        throw new AtlasOpsError(
          "SOURCE_DELETED",
          `${observation.sourceId} was deleted at ${tombstone.deletedAt} by ` +
            `${tombstone.orderedBy} ("${tombstone.reason}"). Upstream still lists it, but ` +
            `resurrecting it on the next crawl would make the deletion advisory. Reinstating it ` +
            `is a separate, attributed act.`,
          "observation.sourceId",
        );
      }

      // Resolved before anything else is decided, including on the unchanged path: a label that
      // stopped resolving is an ingestion failure whether or not the bytes moved (PRD 6.1).
      const acl = observedAcl(observation);
      const observedAt = requireInstant(observation.observedAt, "observation.observedAt");

      if (entry === undefined) {
        const created: Entry = {
          sourceId: observation.sourceId,
          versions: new Map([[versionId, versionFrom(observation, null)]]),
          written: [versionId],
          headLog: [{ at: observedAt, from: null, to: versionId, reason: "observed" }],
          aclLog: [{ at: observedAt, acl }],
          head: versionId,
          tombstone: null,
        };
        entries.set(observation.sourceId, created);
        return { outcome: "created", version: liveOrFail(created) };
      }

      const labelChanged = !sameAcl(currentAcl(entry), acl);
      if (labelChanged) entry.aclLog.push({ at: observedAt, acl });

      // PRD 4.2's fast path: one hash comparison, no parse, no embedding call.
      if (entry.head === versionId) {
        return { outcome: labelChanged ? "acl-changed" : "unchanged", version: liveOrFail(entry) };
      }

      const known = entry.versions.has(versionId);
      if (!known) {
        entry.versions.set(versionId, versionFrom(observation, entry.head));
        entry.written.push(versionId);
      }

      entry.headLog.push({
        at: observedAt,
        from: entry.head,
        to: versionId,
        reason: known ? "restored" : "observed",
      });
      entry.head = versionId;

      return { outcome: known ? "restored" : "created", version: liveOrFail(entry) };
    },

    delete(order: CorpusOrder): Tombstone {
      const at = requireOrder(order, "deleting");
      const entry = entryFor(order.sourceId, "delete");

      // Deleting twice is not an error. A delete that fails because it already happened makes
      // every retry path in the layers above either swallow errors or skip the retry.
      if (entry.tombstone !== null) return entry.tombstone;

      const tombstone: Tombstone = {
        sourceId: order.sourceId,
        deletedAt: at,
        orderedBy: order.orderedBy.id,
        reason: order.reason,
        purge: entry.written.map((sourceVersionId) => ({
          sourceId: order.sourceId,
          sourceVersionId,
        })),
      };

      entry.headLog.push({ at, from: entry.head, to: null, reason: "deleted" });
      entry.head = null;
      entry.aclLog.push({ at, acl: DENY_ALL });
      entry.tombstone = tombstone;
      return tombstone;
    },

    reinstate(order: CorpusOrder): SourceState {
      const at = requireOrder(order, "reinstating");
      const entry = entryFor(order.sourceId, "reinstate");

      if (entry.tombstone === null) {
        throw new AtlasOpsError(
          "VALIDATION",
          `${order.sourceId} is not deleted, so there is nothing to reinstate`,
          "order.sourceId",
        );
      }

      // The head the deletion moved away from. Restoring to "the newest version" instead would
      // silently promote content that was never live.
      const deletion = [...entry.headLog].reverse().find((move) => move.reason === "deleted");
      entry.headLog.push({ at, from: null, to: deletion?.from ?? null, reason: "reinstated" });
      entry.head = deletion?.from ?? null;
      entry.tombstone = null;

      // The label is not restored with the pointer. The deny-all written at deletion time stands
      // until a connector observes the source again and resolves a label for it.
      return snapshot(entry);
    },

    state: (sourceId: SourceId): SourceState | null => {
      const entry = entries.get(sourceId);
      return entry === undefined ? null : snapshot(entry);
    },

    sources: (): readonly SourceId[] => [...entries.keys()].sort(),

    liveVersion: (sourceId: SourceId): SourceVersion | null => {
      const entry = entries.get(sourceId);
      return entry === undefined ? null : liveRecord(entry);
    },

    version: (ref: VersionRef): SourceVersion | null =>
      entries.get(ref.sourceId)?.versions.get(ref.sourceVersionId) ?? null,
  };
}
