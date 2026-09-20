/**
 * Contract tests.
 *
 * These assert the invariants the PRD makes non-negotiable, not the shape of the code. Each one
 * corresponds to a failure that is silent in production if it is not caught here: a chunk
 * identifier that will not survive re-ingestion, an ACL that defaults to permissive, an index that
 * mixes embedding models, a claim with no citation behind it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canRead, parseAclLabel, readableByPredicate, requireResolvedAcl } from "./acl.js";
import { citedChunkIds, parseAnswer, renderProse } from "./answer.js";
import { assertSingleEmbeddingModel, parseChunk, type Chunk } from "./chunk.js";
import { AtlasOpsError, ValidationError } from "./errors.js";
import { contentHashOf, isContentHash } from "./hash.js";
import {
  decomposeChunkId,
  formatChunkId,
  formatGroupId,
  formatSourceId,
  formatSourceVersionId,
  parseChunkId,
  parseSourceId,
  parseSourceVersionId,
  sourceVersionContentHash,
} from "./ids.js";
import { parseSourceVersion } from "./source.js";

/**
 * Fixtures are read as untrusted JSON rather than imported as objects, because that is the path
 * real input takes. The `$why` key documents each invalid fixture for a human and is stripped
 * before parsing, so the fixture fails for the reason it was written to demonstrate rather than
 * for carrying an extra key.
 */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return parsed;
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([key]) => key !== "$why"),
  );
}

const VERSION_HASH = contentHashOf("atlasops-fixture-source-v1");
const VERSION_ID = formatSourceVersionId(VERSION_HASH);

describe("identifiers round-trip", () => {
  it("returns the same value through format and parse", () => {
    const sourceId = formatSourceId("handbook.retention-policy");
    expect(parseSourceId(sourceId, "sourceId")).toBe(sourceId);
  });

  it("derives a version identifier from content and recovers the hash", () => {
    expect(parseSourceVersionId(VERSION_ID, "id")).toBe(VERSION_ID);
    expect(sourceVersionContentHash(VERSION_ID)).toBe(VERSION_HASH);
  });

  it("composes and decomposes a chunk identifier", () => {
    const chunkId = formatChunkId(VERSION_ID, 3);
    expect(parseChunkId(chunkId, "chunkId")).toBe(chunkId);
    expect(decomposeChunkId(chunkId)).toEqual({ sourceVersionId: VERSION_ID, ordinal: 3 });
  });

  it("produces the same chunk identifier for the same input, every time", () => {
    // PRD 4.5 requires re-ingestion to produce a byte-identical chunk set. Derived identifiers
    // give that by construction rather than by the pipeline happening to be deterministic.
    expect(formatChunkId(VERSION_ID, 7)).toBe(formatChunkId(VERSION_ID, 7));
  });

  it("refuses an identifier with the wrong prefix", () => {
    expect(() => parseSourceId("grp_engineering", "sourceId")).toThrow(ValidationError);
  });

  it("refuses an un-normalised identifier body", () => {
    expect(() => formatSourceId("https://example.com/a b")).toThrow(ValidationError);
  });

  it("refuses a version identifier that is not a digest", () => {
    expect(() => parseSourceVersionId("sv_not-a-digest", "id")).toThrow(/64-character sha256/);
  });
});

describe("content hashes", () => {
  it("is stable for identical input", () => {
    expect(contentHashOf("abc")).toBe(contentHashOf("abc"));
  });

  it("differs for different input", () => {
    expect(contentHashOf("abc")).not.toBe(contentHashOf("abd"));
  });

  it("recognises its own format and rejects a bare digest", () => {
    expect(isContentHash(contentHashOf("abc"))).toBe(true);
    expect(isContentHash("d094f486")).toBe(false);
  });
});

describe("the chunk contract (PRD 4.4)", () => {
  it("accepts the known-good fixture", () => {
    const chunk = parseChunk(fixture("chunk.valid.json"));
    expect(chunk.ordinal).toBe(3);
    expect(chunk.headingPath).toEqual(["Data handling", "Retention"]);
    expect(chunk.embedding.dimension).toBe(3072);
  });

  it("rejects the known-bad fixture, whose identifier disagrees with its ordinal", () => {
    expect(() => parseChunk(fixture("chunk.invalid-derived-id.json"))).toThrow(
      /does not agree with sourceVersionId/,
    );
  });

  it("rejects an unknown field rather than ignoring it", () => {
    const chunk = fixture("chunk.valid.json") as Record<string, unknown>;
    expect(() => parseChunk({ ...chunk, effectiveDat: "2026-04-01T00:00:00.000Z" })).toThrow(
      /unknown field\(s\): effectiveDat/,
    );
  });

  it("rejects a zero-width character span", () => {
    const chunk = fixture("chunk.valid.json") as Record<string, unknown>;
    expect(() => parseChunk({ ...chunk, charStart: 1840, charEnd: 1840 })).toThrow(
      /cannot support a citation/,
    );
  });

  it("rejects an embedding reference with no model identifier", () => {
    const chunk = fixture("chunk.valid.json") as Record<string, unknown>;
    expect(() => parseChunk({ ...chunk, embedding: { dimension: 3072 } })).toThrow(ValidationError);
  });

  it("rejects a timestamp that is not normalised ISO 8601", () => {
    const chunk = fixture("chunk.valid.json") as Record<string, unknown>;
    expect(() => parseChunk({ ...chunk, effectiveDate: "2026-04-01" })).toThrow(
      /normalised ISO 8601/,
    );
  });
});

describe("mixed embedding models are refused (PRD 4.4)", () => {
  function chunkWithModel(ordinal: number, id: string, dimension: number): Chunk {
    const base = fixture("chunk.valid.json") as Record<string, unknown>;
    return parseChunk({
      ...base,
      chunkId: formatChunkId(VERSION_ID, ordinal),
      ordinal,
      embedding: { id, dimension },
    });
  }

  it("accepts a candidate set from one model and reports it", () => {
    const model = assertSingleEmbeddingModel([
      chunkWithModel(1, "text-embedding-3-large", 3072),
      chunkWithModel(2, "text-embedding-3-large", 3072),
    ]);
    expect(model?.id).toBe("text-embedding-3-large");
  });

  it("throws on two models, because the alternative is plausible nonsense", () => {
    expect(() =>
      assertSingleEmbeddingModel([
        chunkWithModel(1, "text-embedding-3-large", 3072),
        chunkWithModel(2, "bge-large-en-v1.5", 1024),
      ]),
    ).toThrow(AtlasOpsError);
  });

  it("throws on the same model at two dimensions", () => {
    let thrown: unknown;
    try {
      assertSingleEmbeddingModel([
        chunkWithModel(1, "text-embedding-3-large", 3072),
        chunkWithModel(2, "text-embedding-3-large", 1536),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AtlasOpsError).code).toBe("MIXED_EMBEDDING_MODEL");
  });

  it("reports null for an empty candidate set rather than throwing", () => {
    expect(assertSingleEmbeddingModel([])).toBeNull();
  });
});

describe("access control defaults to deny (PRD 6.1)", () => {
  const engineering = formatGroupId("engineering");
  const legal = formatGroupId("legal");

  it("grants read on an intersecting group", () => {
    const label = parseAclLabel({ readableBy: [engineering], existence: "visible" }, "acl");
    expect(canRead(label, [engineering, legal])).toBe(true);
  });

  it("denies when the principal holds no listed group", () => {
    const label = parseAclLabel({ readableBy: [legal], existence: "visible" }, "acl");
    expect(canRead(label, [engineering])).toBe(false);
  });

  it("treats an empty readable set as nobody, never as everybody", () => {
    // This is the leak the section exists to prevent, so it is asserted directly.
    const label = parseAclLabel({ readableBy: [], existence: "visible" }, "acl");
    expect(canRead(label, [engineering, legal])).toBe(false);
  });

  it("fails ingestion loudly when the ACL could not be resolved", () => {
    let thrown: unknown;
    try {
      requireResolvedAcl(null, "source.acl", "src_handbook");
      throw new Error("expected requireResolvedAcl to throw");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AtlasOpsError).code).toBe("ACL_UNRESOLVED");
  });

  it("produces a stable predicate regardless of group resolution order", () => {
    expect(readableByPredicate([legal, engineering, legal])).toEqual(
      readableByPredicate([engineering, legal]),
    );
  });

  it("rejects an unknown existence policy", () => {
    expect(() => parseAclLabel({ readableBy: [], existence: "internal" }, "acl")).toThrow(
      /visible \| hidden/,
    );
  });
});

describe("source versions are content-addressed (PRD 4.1)", () => {
  const base = {
    sourceId: formatSourceId("handbook.retention-policy"),
    sourceVersionId: VERSION_ID,
    contentHash: VERSION_HASH,
    observedAt: "2026-03-02T09:15:00.000Z",
    effectiveDate: null,
    upstreamRevision: "r-4821",
    supersedes: null,
    acl: { readableBy: [formatGroupId("engineering")], existence: "visible" },
  };

  it("accepts a version whose identifier is its content hash", () => {
    expect(parseSourceVersion(base).upstreamRevision).toBe("r-4821");
  });

  it("rejects an allocated identifier, which would make re-ingestion non-idempotent", () => {
    const wrong = formatSourceVersionId(contentHashOf("different bytes entirely"));
    expect(() => parseSourceVersion({ ...base, sourceVersionId: wrong })).toThrow(
      /is not the identifier for contentHash/,
    );
  });

  it("rejects a version that supersedes itself", () => {
    expect(() => parseSourceVersion({ ...base, supersedes: VERSION_ID })).toThrow(
      /cannot supersede itself/,
    );
  });
});

describe("the answer contract (PRD 7.1)", () => {
  it("accepts the known-good fixture", () => {
    const answer = parseAnswer(fixture("answer.valid.json"));
    expect(answer.abstained).toBe(false);
  });

  it("rejects the known-bad fixture, whose second claim cites nothing", () => {
    expect(() => parseAnswer(fixture("answer.invalid-unsupported-claim.json"))).toThrow(
      /at least one supporting reference/,
    );
  });

  it("derives prose from the structure rather than carrying it separately", () => {
    const answer = parseAnswer(fixture("answer.valid.json"));
    expect(renderProse(answer)).toBe(
      "Only the current version of a source stays live in the retrieval index. " +
        "Prior versions are retained in the corpus store for audit and temporal evaluation.",
    );
  });

  it("lists cited chunks once each, in first-cited order", () => {
    const answer = parseAnswer(fixture("answer.valid.json"));
    expect(citedChunkIds(answer)).toEqual([formatChunkId(VERSION_ID, 3)]);
  });

  it("accepts an abstention and renders no prose for it", () => {
    const abstention = parseAnswer({
      requestId: "req_01k9z4m2nq",
      abstained: true,
      reason: "permission-excluded",
    });
    expect(abstention.abstained).toBe(true);
    expect(renderProse(abstention)).toBe("");
    expect(citedChunkIds(abstention)).toEqual([]);
  });

  it("rejects an unknown abstention reason", () => {
    expect(() =>
      parseAnswer({ requestId: "req_01k9z4m2nq", abstained: true, reason: "tired" }),
    ).toThrow(ValidationError);
  });

  it("rejects an answer with no segments at all", () => {
    expect(() =>
      parseAnswer({ requestId: "req_01k9z4m2nq", abstained: false, segments: [] }),
    ).toThrow(ValidationError);
  });

  it("rejects a citation span that points at nothing", () => {
    const answer = fixture("answer.valid.json") as {
      segments: { references: { span: { start: number; end: number } }[] }[];
    };
    const broken = structuredClone(answer);
    broken.segments[0]!.references[0]!.span = { start: 12, end: 12 };
    expect(() => parseAnswer(broken)).toThrow(/points at nothing/);
  });
});
