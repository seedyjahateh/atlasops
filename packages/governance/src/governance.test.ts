/**
 * Governance tests.
 *
 * The permission cases are data in `fixtures/permissions.json` rather than code, so adding a case
 * is not adding a test — and so the same set can be replayed by the governance probe PRD 12 item 3
 * requires before this project may be promoted.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AtlasOpsError,
  contentHashOf,
  formatChunkId,
  formatGroupId,
  formatPrincipalId,
  formatRequestId,
  formatSourceVersionId,
  parseAclLabel,
  type AclLabel,
  type GroupId,
  type PrincipalId,
} from "@atlasops/contracts";
import { describe, expect, it } from "vitest";

import {
  createAuthorizationJournal,
  failingAuditSink,
  inMemoryAuditSink,
  releaseAnswer,
  type ChunkReference,
} from "./audit.js";
import { abstentionMessage, outcomeFor } from "./existence.js";
import { computeCacheKey, groupSetHash, permissionedCacheKey } from "./groupset.js";
import {
  normaliseGroups,
  parseGroupMap,
  resolvePrincipal,
  staticGroupResolver,
  unavailableGroupResolver,
} from "./principal.js";

interface PermissionCase {
  readonly name: string;
  readonly principal: string;
  readonly label: unknown;
  readonly allowed: boolean;
  readonly reason: string;
}

interface PermissionFixture {
  readonly memberships: Readonly<Record<string, readonly string[]>>;
  readonly cases: readonly PermissionCase[];
}

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/permissions.json", import.meta.url)), "utf8"),
) as PermissionFixture;

const MEMBERSHIPS: Record<string, readonly GroupId[]> = Object.fromEntries(
  Object.entries(FIXTURE.memberships).map(([principal, groups]) => [
    principal,
    groups.map((group) => group as GroupId),
  ]),
);

const REQUEST = formatRequestId("01k9z4m2nq");
const QUERY_HASH = contentHashOf("what is the retention policy");
const VERSION = formatSourceVersionId(contentHashOf("some-source-bytes"));

function chunkRef(ordinal: number): ChunkReference {
  return { chunkId: formatChunkId(VERSION, ordinal), sourceVersionId: VERSION };
}

const EMPTY_SEAL = {
  promptChunks: [] as readonly ChunkReference[],
  citedChunks: [] as readonly ChunkReference[],
  models: [] as readonly string[],
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  stageTimings: [],
  writtenAt: "2026-09-20T12:00:00.000Z",
};

async function makeJournal(
  principalId: string,
): Promise<ReturnType<typeof createAuthorizationJournal>> {
  const principal = await resolvePrincipal(
    staticGroupResolver(MEMBERSHIPS),
    principalId as PrincipalId,
  );
  return createAuthorizationJournal({ requestId: REQUEST, principal, queryHash: QUERY_HASH });
}

describe("group resolution (PRD 6.1)", () => {
  it("normalises order and duplicates so the same memberships produce the same set", () => {
    const a = normaliseGroups([formatGroupId("legal"), formatGroupId("engineering")]);
    const b = normaliseGroups([
      formatGroupId("engineering"),
      formatGroupId("legal"),
      formatGroupId("engineering"),
    ]);
    expect(a).toEqual(b);
  });

  it("fails closed when membership cannot be determined", async () => {
    // PRD 9.4: permission resolution is the one dependency with no degraded mode.
    await expect(
      resolvePrincipal(unavailableGroupResolver(), formatPrincipalId("alice")),
    ).rejects.toThrow(AtlasOpsError);
  });

  it("does not treat a failed resolution as an empty group set", async () => {
    // An empty set means "reads nothing"; a failure means "we do not know". Returning empty on
    // failure would silently turn an outage into a quiet, total denial that looks like a bug
    // report rather than an incident.
    let code = "";
    try {
      await resolvePrincipal(unavailableGroupResolver(), formatPrincipalId("alice"));
    } catch (error) {
      code = (error as AtlasOpsError).code;
    }
    expect(code).toBe("ACL_UNRESOLVED");
  });

  it("resolves an existing principal to a sorted set", async () => {
    const principal = await resolvePrincipal(
      staticGroupResolver(MEMBERSHIPS),
      "prn_bob" as PrincipalId,
    );
    expect(principal.groups).toEqual([formatGroupId("engineering"), formatGroupId("legal")]);
  });
});

describe("the permission fixture set", () => {
  for (const testCase of FIXTURE.cases) {
    it(testCase.name, async () => {
      const journal = await makeJournal(testCase.principal);
      const label: AclLabel = parseAclLabel(testCase.label, "label");

      const allowed = journal.authorize("chunk-under-test", label);

      expect(allowed).toBe(testCase.allowed);
      expect(journal.decisions()).toHaveLength(1);
      expect(journal.decisions()[0]?.reason).toBe(testCase.reason);
    });
  }

  it("covers both outcomes, so a fixture that only ever allows cannot pass unnoticed", () => {
    const outcomes = new Set(FIXTURE.cases.map((entry) => entry.allowed));
    expect(outcomes).toEqual(new Set([true, false]));
  });
});

describe("every authorisation decision is recorded (PRD 6.6)", () => {
  it("records one decision per authorize call, in order", async () => {
    const journal = await makeJournal("prn_alice");
    const permitted = parseAclLabel(
      { readableBy: [formatGroupId("engineering")], existence: "visible" },
      "label",
    );
    const refused = parseAclLabel(
      { readableBy: [formatGroupId("legal")], existence: "visible" },
      "label",
    );

    journal.authorize("chunk-a", permitted);
    journal.authorize("chunk-b", refused);
    journal.authorize("chunk-c", permitted);

    const record = journal.seal(EMPTY_SEAL);
    expect(record.decisions.map((decision) => decision.resource)).toEqual([
      "chunk-a",
      "chunk-b",
      "chunk-c",
    ]);
    expect(record.decisions.filter((decision) => decision.allowed)).toHaveLength(2);
  });

  it("carries the principal, the group-set hash and the compiled predicate", async () => {
    const journal = await makeJournal("prn_bob");
    const record = journal.seal(EMPTY_SEAL);
    expect(record.principalId).toBe("prn_bob");
    expect(record.groupSetHash).toBe(groupSetHash(MEMBERSHIPS.prn_bob ?? []));
    expect(record.predicate).toEqual([formatGroupId("engineering"), formatGroupId("legal")]);
  });

  it("refuses an authorisation after the record is sealed", async () => {
    const journal = await makeJournal("prn_alice");
    journal.seal(EMPTY_SEAL);
    const label = parseAclLabel(
      { readableBy: [formatGroupId("engineering")], existence: "visible" },
      "label",
    );
    expect(() => journal.authorize("late", label)).toThrow(/after the audit record was sealed/);
  });

  it("refuses to seal twice", async () => {
    const journal = await makeJournal("prn_alice");
    journal.seal(EMPTY_SEAL);
    expect(() => journal.seal(EMPTY_SEAL)).toThrow(/sealed twice/);
  });

  it("refuses a record citing a chunk that never entered the prompt", async () => {
    const journal = await makeJournal("prn_alice");
    expect(() =>
      journal.seal({ ...EMPTY_SEAL, promptChunks: [chunkRef(1)], citedChunks: [chunkRef(2)] }),
    ).toThrow(/never entered the prompt/);
  });
});

describe("the audit is written before the answer is returned (PRD 6.6)", () => {
  it("writes the record and then returns the answer", async () => {
    const sink = inMemoryAuditSink();
    const journal = await makeJournal("prn_alice");
    const record = journal.seal(EMPTY_SEAL);

    const answer = await releaseAnswer(sink, record, "the answer");

    expect(answer).toBe("the answer");
    expect(sink.records()).toHaveLength(1);
  });

  it("withholds the answer when the audit write fails", async () => {
    // An audit log that can be lost on the response path is not an audit log, so a failed write
    // is a failed request rather than an answer with a missing record.
    const journal = await makeJournal("prn_alice");
    const record = journal.seal(EMPTY_SEAL);
    await expect(releaseAnswer(failingAuditSink(), record, "the answer")).rejects.toThrow(
      /audit store unavailable/,
    );
  });
});

describe("caches are keyed on the group set (PRD 6.3)", () => {
  const alice = groupSetHash([formatGroupId("engineering")]);
  const bob = groupSetHash([formatGroupId("engineering"), formatGroupId("legal")]);

  it("gives two principals different keys for the same query", () => {
    // A cache keyed on query text alone is a permission bypass with a fast path.
    expect(permissionedCacheKey("retrieval", QUERY_HASH, alice)).not.toBe(
      permissionedCacheKey("retrieval", QUERY_HASH, bob),
    );
  });

  it("is insensitive to the order groups were resolved in", () => {
    expect(groupSetHash([formatGroupId("legal"), formatGroupId("engineering")])).toBe(bob);
  });

  it("does not collide across a separator boundary", () => {
    // Joining on a character an identifier may contain would let two different sets hash alike,
    // which is a permission collision rather than a cosmetic one.
    expect(groupSetHash([formatGroupId("a-b")])).not.toBe(
      groupSetHash([formatGroupId("a"), formatGroupId("b")]),
    );
  });

  it("keys the embedding compute cache without a principal, which is the one allowed exception", () => {
    const key = computeCacheKey("embedding", contentHashOf("chunk text"));
    expect(key).not.toContain(alice);
    expect(key).toBe(computeCacheKey("embedding", contentHashOf("chunk text")));
  });
});

describe("abstention wording is not an oracle (PRD 6.4)", () => {
  it("says exactly the same thing when nothing was found and when hidden material was excluded", () => {
    // If these differ by a single character, an attacker enumerates the corpus by the shape of
    // the refusal without ever reading a document.
    expect(abstentionMessage("excluded-hidden")).toBe(abstentionMessage("nothing-relevant"));
  });

  it("says something different for visible material, which is a deliberate disclosure", () => {
    expect(abstentionMessage("excluded-visible")).not.toBe(abstentionMessage("nothing-relevant"));
  });

  it("chooses hidden wording when both kinds were excluded", () => {
    expect(outcomeFor(["visible", "hidden"])).toBe("excluded-hidden");
  });

  it("chooses nothing-relevant when nothing was excluded", () => {
    expect(outcomeFor([])).toBe("nothing-relevant");
  });

  it("chooses visible wording only when every exclusion was visible", () => {
    expect(outcomeFor(["visible", "visible"])).toBe("excluded-visible");
  });
});

describe("a membership map read from data (P14a)", () => {
  it("parses principals to normalised group sets", () => {
    const map = parseGroupMap({
      prn_alice: ["grp_engineering", "grp_everyone"],
      prn_frank: ["grp_finance"],
    });

    // Normalised on the way in, because group-set identity is what every cache key and audit
    // record downstream depends on.
    expect(map.prn_alice).toEqual(["grp_engineering", "grp_everyone"]);
    expect(map.prn_frank).toEqual(["grp_finance"]);
  });

  it("ignores $-prefixed keys, which are comments in these files", () => {
    const map = parseGroupMap({ $comment: "why alice is engineering", prn_alice: ["grp_x"] });
    expect(Object.keys(map)).toEqual(["prn_alice"]);
  });

  it("refuses a malformed identifier rather than carrying it to a permission check", () => {
    // A group identifier that never matches anything produces a principal who reads nothing, which
    // looks exactly like a working system with an empty corpus.
    expect(() => parseGroupMap({ prn_alice: ["engineering"] })).toThrow();
    expect(() => parseGroupMap({ alice: ["grp_engineering"] })).toThrow();
  });

  it("refuses a map naming no principal", () => {
    expect(() => parseGroupMap({ $comment: "only a comment" })).toThrow(/names no principal/);
  });

  it("refuses groups that are not an array", () => {
    expect(() => parseGroupMap({ prn_alice: "grp_engineering" })).toThrow(/must be an array/);
  });
});
