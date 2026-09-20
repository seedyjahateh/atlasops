/**
 * Corpus tests.
 *
 * The three acceptance items for this phase are each asserted directly rather than implied: a
 * version is immutable once written, change detection separates added from modified from deleted,
 * and a deletion is honoured through to retrieval eligibility.
 *
 * The change-detection cases are data in `fixtures/revisions.json`, so adding a case is not adding
 * a test. The fixture states the *text* of each source and the test derives the hash with the same
 * function the store uses — a hand-written hash would be a constant nobody could check.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  contentHashOf,
  isAtlasOpsError,
  parseGroupId,
  parsePrincipalId,
  parseSourceId,
  type AclLabel,
  type ContentHash,
  type SourceId,
} from "@atlasops/contracts";
import type { Principal } from "@atlasops/governance";
import { describe, expect, it } from "vitest";

import { detectChanges, hasWork, type ConnectorListing } from "./changes.js";
import type { SourceObservation } from "./observation.js";
import { isRetrievable, retentionPlan, versionAsOf } from "./retention.js";
import { inMemoryCorpusStore, type CorpusStore, type HeadMove } from "./store.js";

const ENGINEERING = parseGroupId("grp_engineering", "fixture");
const SUPPORT = parseGroupId("grp_support", "fixture");

const ACL: AclLabel = { readableBy: [ENGINEERING], existence: "visible" };

const ADMIN: Principal = {
  id: parsePrincipalId("prn_admin", "fixture"),
  groups: [ENGINEERING],
};

const HANDBOOK = parseSourceId("src_handbook", "fixture");

const MARCH = "2026-03-01T00:00:00.000Z";
const APRIL = "2026-04-01T00:00:00.000Z";
const MAY = "2026-05-01T00:00:00.000Z";

function observe(
  sourceId: SourceId,
  text: string,
  observedAt: string,
  acl: unknown = ACL,
): SourceObservation {
  return { sourceId, contentHash: contentHashOf(text), observedAt, acl };
}

function deletionOrder(sourceId: SourceId, at: string, reason = "removed at the owner's request") {
  return { sourceId, at, orderedBy: ADMIN, reason };
}

/* ----------------------------------------------------------------------------- the fixture */

interface ListingFixture {
  readonly connector: string;
  readonly observedAt: string;
  readonly complete: boolean;
  readonly sources: readonly { readonly sourceId: string; readonly text: string }[];
}

interface RevisionFixture {
  readonly acl: unknown;
  readonly baseline: ListingFixture;
  readonly revision: ListingFixture;
  readonly expected: Readonly<Record<string, readonly string[]>>;
}

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/revisions.json", import.meta.url)), "utf8"),
) as RevisionFixture;

function listingOf(fixture: ListingFixture): ConnectorListing {
  return {
    connector: fixture.connector,
    observedAt: fixture.observedAt,
    complete: fixture.complete,
    sources: fixture.sources.map((entry) => ({
      sourceId: parseSourceId(entry.sourceId, "fixture.sourceId"),
      contentHash: contentHashOf(entry.text),
    })),
  };
}

function ingest(store: CorpusStore, fixture: ListingFixture): void {
  for (const entry of fixture.sources) {
    store.append({
      sourceId: parseSourceId(entry.sourceId, "fixture.sourceId"),
      contentHash: contentHashOf(entry.text),
      observedAt: fixture.observedAt,
      acl: FIXTURE.acl,
    });
  }
}

/* ------------------------------------------------------------------------------- the tests */

describe("identity comes from the bytes (PRD 4.1)", () => {
  it("gives the same version identifier to the same content, whenever it was observed", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "text", MARCH));

    const other = inMemoryCorpusStore();
    const second = other.append(observe(HANDBOOK, "text", MAY));

    expect(first.version.sourceVersionId).toBe(second.version.sourceVersionId);
  });

  it("refuses a source whose access label could not be resolved (PRD 6.1)", () => {
    const store = inMemoryCorpusStore();
    try {
      store.append(observe(HANDBOOK, "text", MARCH, null));
      expect.unreachable("an unresolved ACL must stop ingestion");
    } catch (error) {
      expect(isAtlasOpsError(error) && error.code).toBe("ACL_UNRESOLVED");
    }
  });

  it("resolves the label even when the bytes are unchanged", () => {
    // A label that stopped resolving is an ingestion failure whether or not anyone edited the
    // document. Checking it only on the slow path is how a directory outage becomes a silent
    // "nothing changed" run.
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    expect(() => store.append(observe(HANDBOOK, "text", APRIL, null))).toThrow(/no resolvable ACL/);
  });

  it("rejects an observation time that is not a normalised instant", () => {
    const store = inMemoryCorpusStore();
    expect(() => store.append(observe(HANDBOOK, "text", "March 2026"))).toThrow(/ISO 8601/);
  });
});

describe("a version is immutable once written", () => {
  it("does not rewrite the stored record when the same bytes are observed again", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    const result = store.append(observe(HANDBOOK, "text", MAY));

    expect(result.outcome).toBe("unchanged");
    expect(store.state(HANDBOOK)!.versions).toHaveLength(1);
    expect(store.state(HANDBOOK)!.versions[0]!.observedAt).toBe(MARCH);
  });

  it("keeps the supersedes pointer the version was written with", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    const second = store.append(observe(HANDBOOK, "v2", APRIL));

    expect(second.version.supersedes).toBe(first.version.sourceVersionId);
    expect(store.state(HANDBOOK)!.versions[0]!.supersedes).toBeNull();
  });

  it("hands out copies, so a caller cannot edit the store's history", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));

    const log = store.state(HANDBOOK)!.headLog as HeadMove[];
    log.push({ at: MAY, from: null, to: null, reason: "deleted" });

    expect(store.state(HANDBOOK)!.headLog).toHaveLength(1);
  });
});

describe("rollback is a pointer move, not a rewrite (PRD 4.1)", () => {
  it("moves the head back to a version it already holds", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    store.append(observe(HANDBOOK, "v2", APRIL));
    const back = store.append(observe(HANDBOOK, "v1", MAY));

    expect(back.outcome).toBe("restored");
    expect(store.state(HANDBOOK)!.head).toBe(first.version.sourceVersionId);
  });

  it("writes no second copy of the restored version", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.append(observe(HANDBOOK, "v2", APRIL));
    store.append(observe(HANDBOOK, "v1", MAY));

    // Two sets of bytes have ever existed, so there are two records and three head moves.
    expect(store.state(HANDBOOK)!.versions).toHaveLength(2);
    expect(store.state(HANDBOOK)!.headLog).toHaveLength(3);
    expect(store.state(HANDBOOK)!.headLog[2]!.reason).toBe("restored");
  });
});

describe("an access label is not a version (ADR 0003)", () => {
  it("records a label change without creating a version", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    const result = store.append(
      observe(HANDBOOK, "text", APRIL, { readableBy: [SUPPORT], existence: "visible" }),
    );

    expect(result.outcome).toBe("acl-changed");
    expect(store.state(HANDBOOK)!.versions).toHaveLength(1);
  });

  it("serves the current label, not the one frozen on the record", () => {
    // A revocation must take effect now. Waiting for somebody to edit the document would make the
    // answer to "how long after revocation can this be read" a number nobody chose.
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    store.append(observe(HANDBOOK, "text", APRIL, { readableBy: [], existence: "hidden" }));

    expect(store.liveVersion(HANDBOOK)!.acl.readableBy).toEqual([]);
    expect(store.state(HANDBOOK)!.versions[0]!.acl.readableBy).toEqual([ENGINEERING]);
  });

  it("reports an unchanged label as unchanged even when the groups arrive in another order", () => {
    const store = inMemoryCorpusStore();
    const both: AclLabel = { readableBy: [ENGINEERING, SUPPORT], existence: "visible" };
    const reversed: AclLabel = { readableBy: [SUPPORT, ENGINEERING], existence: "visible" };

    store.append(observe(HANDBOOK, "text", MARCH, both));
    expect(store.append(observe(HANDBOOK, "text", APRIL, reversed)).outcome).toBe("unchanged");
  });
});

describe("deletion is a first-class, attributed act (PRD 4.2)", () => {
  it("names every version that must be purged, not just the live one", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.append(observe(HANDBOOK, "v2", APRIL));

    const tombstone = store.delete(deletionOrder(HANDBOOK, MAY));

    expect(tombstone.purge).toHaveLength(2);
    expect(tombstone.orderedBy).toBe(ADMIN.id);
  });

  it("refuses a deletion with no stated reason", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    expect(() => store.delete(deletionOrder(HANDBOOK, MAY, "  "))).toThrow(/no stated reason/);
  });

  it("refuses to delete a source the corpus has never seen", () => {
    // Succeeding quietly would turn a mistyped identifier into a document that was never removed,
    // reported as a successful deletion.
    const store = inMemoryCorpusStore();
    expect(() => store.delete(deletionOrder(HANDBOOK, MAY))).toThrow(/holds no record/);
  });

  it("is idempotent, so a retry does not have to swallow an error", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));

    const first = store.delete(deletionOrder(HANDBOOK, APRIL));
    const second = store.delete(deletionOrder(HANDBOOK, MAY));

    expect(second).toEqual(first);
    expect(second.deletedAt).toBe(APRIL);
  });

  it("does not let the next crawl resurrect a deleted source", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.delete(deletionOrder(HANDBOOK, APRIL));

    try {
      store.append(observe(HANDBOOK, "v1", MAY));
      expect.unreachable("a deleted source must not be re-ingested silently");
    } catch (error) {
      expect(isAtlasOpsError(error) && error.code).toBe("SOURCE_DELETED");
    }
  });

  it("stops serving the source the moment it is deleted", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.delete(deletionOrder(HANDBOOK, APRIL));

    expect(store.liveVersion(HANDBOOK)).toBeNull();
    expect(store.state(HANDBOOK)!.head).toBeNull();
  });
});

describe("reinstatement is its own attributed act", () => {
  it("restores the version that was live, not the newest one written", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    store.append(observe(HANDBOOK, "v2", APRIL));
    store.append(observe(HANDBOOK, "v1", APRIL));
    store.delete(deletionOrder(HANDBOOK, MAY));

    const state = store.reinstate(deletionOrder(HANDBOOK, MAY, "deleted in error"));

    expect(state.tombstone).toBeNull();
    expect(state.head).toBe(first.version.sourceVersionId);
  });

  it("does not restore the access label with the pointer", () => {
    // The deny-all written at deletion time stands until a connector resolves a label again.
    // Restoring the old label would re-grant access that nobody has re-authorised.
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.delete(deletionOrder(HANDBOOK, APRIL));
    store.reinstate(deletionOrder(HANDBOOK, MAY, "deleted in error"));

    expect(store.liveVersion(HANDBOOK)!.acl.readableBy).toEqual([]);
  });

  it("refuses to reinstate a source that is not deleted", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    expect(() => store.reinstate(deletionOrder(HANDBOOK, MAY, "why"))).toThrow(/not deleted/);
  });
});

describe("change detection (PRD 4.2)", () => {
  it("separates added, modified, unchanged and deleted, against the fixture", () => {
    const store = inMemoryCorpusStore();
    ingest(store, FIXTURE.baseline);

    const changes = detectChanges(store, listingOf(FIXTURE.revision));

    expect(changes.added).toEqual(FIXTURE.expected.added);
    expect(changes.modified).toEqual(FIXTURE.expected.modified);
    expect(changes.unchanged).toEqual(FIXTURE.expected.unchanged);
    expect(changes.deleted).toEqual(FIXTURE.expected.deleted);
    expect(changes.tombstoned).toEqual(FIXTURE.expected.tombstoned);
  });

  it("covers every fixture source, so a case cannot be silently dropped", () => {
    const store = inMemoryCorpusStore();
    ingest(store, FIXTURE.baseline);
    const changes = detectChanges(store, listingOf(FIXTURE.revision));

    const total =
      changes.added.length +
      changes.modified.length +
      changes.unchanged.length +
      changes.deleted.length +
      changes.tombstoned.length;

    expect(total).toBe(FIXTURE.baseline.sources.length + 1);
  });

  it("reports everything as added against an empty corpus", () => {
    const changes = detectChanges(inMemoryCorpusStore(), listingOf(FIXTURE.baseline));
    expect(changes.added).toHaveLength(FIXTURE.baseline.sources.length);
    expect(changes.deleted).toEqual([]);
  });

  it("re-detecting an unchanged listing finds no work at all", () => {
    const store = inMemoryCorpusStore();
    ingest(store, FIXTURE.baseline);
    expect(hasWork(detectChanges(store, listingOf(FIXTURE.baseline)))).toBe(false);
  });

  it("withholds deletions when the listing is not the connector's complete view", () => {
    // The failure this prevents: an expired token returns an empty page, absence is read as
    // deletion, and the corpus is wiped by a run that did exactly what it was told.
    const store = inMemoryCorpusStore();
    ingest(store, FIXTURE.baseline);

    const partial: ConnectorListing = {
      connector: "fixture",
      observedAt: APRIL,
      complete: false,
      sources: [],
    };
    const changes = detectChanges(store, partial);

    expect(changes.deleted).toEqual([]);
    expect(changes.deletionsWithheld).toBe(true);
  });

  it("still reports deletions when a complete listing is genuinely empty", () => {
    const store = inMemoryCorpusStore();
    ingest(store, FIXTURE.baseline);

    const empty: ConnectorListing = {
      connector: "fixture",
      observedAt: APRIL,
      complete: true,
      sources: [],
    };

    expect(detectChanges(store, empty).deleted).toHaveLength(FIXTURE.baseline.sources.length);
  });

  it("refuses a listing that names the same source twice", () => {
    const hash: ContentHash = contentHashOf("text");
    const listing: ConnectorListing = {
      connector: "fixture",
      observedAt: APRIL,
      complete: true,
      sources: [
        { sourceId: HANDBOOK, contentHash: hash },
        { sourceId: HANDBOOK, contentHash: contentHashOf("other") },
      ],
    };

    expect(() => detectChanges(inMemoryCorpusStore(), listing)).toThrow(/listed twice/);
  });

  it("reports a deleted source that upstream still lists as tombstoned, not added", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    store.delete(deletionOrder(HANDBOOK, APRIL));

    const listing: ConnectorListing = {
      connector: "fixture",
      observedAt: MAY,
      complete: true,
      sources: [{ sourceId: HANDBOOK, contentHash: contentHashOf("text") }],
    };
    const changes = detectChanges(store, listing);

    expect(changes.tombstoned).toEqual([HANDBOOK]);
    expect(changes.added).toEqual([]);
  });

  it("does not report a deleted source as deleted a second time", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    store.delete(deletionOrder(HANDBOOK, APRIL));

    const empty: ConnectorListing = {
      connector: "fixture",
      observedAt: MAY,
      complete: true,
      sources: [],
    };

    expect(detectChanges(store, empty).deleted).toEqual([]);
  });
});

describe("retention keeps one version live and the rest auditable (PRD 4.1)", () => {
  it("puts the head in live and every earlier version in retained", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    const second = store.append(observe(HANDBOOK, "v2", APRIL));

    const plan = retentionPlan(store);

    expect(plan.live).toEqual([
      { sourceId: HANDBOOK, sourceVersionId: second.version.sourceVersionId },
    ]);
    expect(plan.retained).toHaveLength(1);
    expect(plan.purge).toEqual([]);
  });

  it("moves a deleted source's whole history into purge, and out of both other lists", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.append(observe(HANDBOOK, "v2", APRIL));
    store.delete(deletionOrder(HANDBOOK, MAY));

    const plan = retentionPlan(store);

    expect(plan.live).toEqual([]);
    expect(plan.retained).toEqual([]);
    expect(plan.purge).toHaveLength(2);
  });

  it("reports one live version per source across the fixture corpus", () => {
    const store = inMemoryCorpusStore();
    ingest(store, FIXTURE.baseline);
    expect(retentionPlan(store).live).toHaveLength(FIXTURE.baseline.sources.length);
  });
});

describe("deletion is honoured through to retrieval eligibility (PRD 4.2)", () => {
  it("makes the head retrievable and everything behind it not", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    const second = store.append(observe(HANDBOOK, "v2", APRIL));

    expect(
      isRetrievable(store, { sourceId: HANDBOOK, sourceVersionId: second.version.sourceVersionId }),
    ).toBe(true);
    expect(
      isRetrievable(store, { sourceId: HANDBOOK, sourceVersionId: first.version.sourceVersionId }),
    ).toBe(false);
  });

  it("answers false for every version of a deleted source — the post-delete probe", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    const second = store.append(observe(HANDBOOK, "v2", APRIL));
    const tombstone = store.delete(deletionOrder(HANDBOOK, MAY));

    expect(tombstone.purge).toHaveLength(2);
    for (const ref of [first, second]) {
      expect(
        isRetrievable(store, {
          sourceId: HANDBOOK,
          sourceVersionId: ref.version.sourceVersionId,
        }),
      ).toBe(false);
    }
  });

  it("answers false for a source it has never held", () => {
    const store = inMemoryCorpusStore();
    const absent = parseSourceId("src_absent", "fixture");
    store.append(observe(HANDBOOK, "v1", MARCH));

    expect(
      isRetrievable(store, {
        sourceId: absent,
        sourceVersionId: store.state(HANDBOOK)!.head!,
      }),
    ).toBe(false);
  });
});

describe("temporal reads, for audit and evaluation only", () => {
  it("answers what the source held at a past instant", () => {
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    const second = store.append(observe(HANDBOOK, "v2", APRIL));

    expect(versionAsOf(store, HANDBOOK, MARCH)?.sourceVersionId).toBe(
      first.version.sourceVersionId,
    );
    expect(versionAsOf(store, HANDBOOK, MAY)?.sourceVersionId).toBe(second.version.sourceVersionId);
  });

  it("returns null before the source existed", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", APRIL));
    expect(versionAsOf(store, HANDBOOK, MARCH)).toBeNull();
  });

  it("follows the head log rather than sorting versions by date", () => {
    // After a rollback the newest record is not what was live. A date sort would return v2.
    const store = inMemoryCorpusStore();
    const first = store.append(observe(HANDBOOK, "v1", MARCH));
    store.append(observe(HANDBOOK, "v2", APRIL));
    store.append(observe(HANDBOOK, "v1", MAY));

    expect(versionAsOf(store, HANDBOOK, MAY)?.sourceVersionId).toBe(first.version.sourceVersionId);
  });

  it("reports the label that was in force then, not the one in force now", () => {
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "text", MARCH));
    store.append(observe(HANDBOOK, "text", APRIL, { readableBy: [SUPPORT], existence: "visible" }));

    expect(versionAsOf(store, HANDBOOK, MARCH)?.acl.readableBy).toEqual([ENGINEERING]);
    expect(versionAsOf(store, HANDBOOK, MAY)?.acl.readableBy).toEqual([SUPPORT]);
  });

  it("returns null at every instant once the source is deleted", () => {
    // A governed system cannot have a "mostly deleted" document, and a temporal read that still
    // answers for March is exactly that.
    const store = inMemoryCorpusStore();
    store.append(observe(HANDBOOK, "v1", MARCH));
    store.delete(deletionOrder(HANDBOOK, APRIL));

    expect(versionAsOf(store, HANDBOOK, MARCH)).toBeNull();
    expect(versionAsOf(store, HANDBOOK, MAY)).toBeNull();
  });
});
