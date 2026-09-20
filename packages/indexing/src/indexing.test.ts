/**
 * Indexing tests (P7).
 *
 * Two of these are unusual and are the point of the phase.
 *
 * **The pre-filter is asserted against the implementation, not the output.** Every search records
 * which rows it touched, and the tests assert that a search examined no row the principal cannot
 * read. Checking the returned candidates would pass equally for a post-filter, which is exactly the
 * implementation PRD 6.2 rejects.
 *
 * **The rejected implementations live here, in the tests, and nowhere else.** A corpus-wide-IDF
 * scorer and a post-filtering search are written out below so that the leaks PRD 6.2 and ADR 0004
 * describe can be demonstrated rather than asserted. Neither exists in `src`.
 */

import {
  contentHashDigest,
  contentHashOf,
  formatChunkId,
  formatSourceVersionId,
  parseChunk,
  parseGroupId,
  parsePrincipalId,
  parseSourceId,
  type AtlasOpsError,
  type ChunkId,
  type ExistencePolicy,
  type GroupId,
} from "@atlasops/contracts";
import { abstentionMessage, outcomeFor, type Principal } from "@atlasops/governance";
import { describe, expect, it } from "vitest";

import { inMemoryLexicalIndex } from "./lexical.js";
import { rowStore } from "./partition.js";
import { compilePredicate, renderPredicate, type CompiledPredicate } from "./predicate.js";
import { rankBy, tokenise, type IndexRow } from "./row.js";
import { assertSameModel, currentSchema, planMigration, type IndexSchema } from "./schema.js";
import { cosine, inMemoryVectorIndex } from "./vector.js";

/* -------------------------------------------------------------------------------- fixtures */

const ENGINEERING = parseGroupId("grp_engineering", "fixture");
const FINANCE = parseGroupId("grp_finance", "fixture");
const PLATFORM = parseGroupId("grp_platform", "fixture");

const EMBEDDING = { id: "fake-embedder", dimension: 8 };
const SCHEMA: IndexSchema = currentSchema(EMBEDDING);

const ALICE: Principal = {
  id: parsePrincipalId("prn_alice", "fixture"),
  groups: [ENGINEERING, PLATFORM],
};
const NOBODY: Principal = { id: parsePrincipalId("prn_nobody", "fixture"), groups: [] };

/** A deterministic unit vector. Local rather than borrowed: indexing may not import the gateway. */
function vectorOf(text: string, dimension: number): readonly number[] {
  const values: number[] = [];
  let block = 0;
  while (values.length < dimension) {
    const digest = contentHashDigest(contentHashOf(`${text}\u001f${String(block)}`));
    for (let at = 0; at + 1 < digest.length && values.length < dimension; at += 2) {
      values.push(Number.parseInt(digest.slice(at, at + 2), 16) / 127.5 - 1);
    }
    block += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? values : values.map((value) => value / norm);
}

function makeRow(
  name: string,
  ordinal: number,
  text: string,
  groups: readonly GroupId[],
  existence: ExistencePolicy = "visible",
): IndexRow {
  const contentHash = contentHashOf(`version-of-${name}`);
  const sourceVersionId = formatSourceVersionId(contentHash);
  const chunk = parseChunk({
    chunkId: formatChunkId(sourceVersionId, ordinal),
    sourceId: parseSourceId(`src_${name}`, "fixture"),
    sourceVersionId,
    ordinal,
    headingPath: [name],
    charStart: 0,
    charEnd: text.length,
    tokenCount: Math.max(1, Math.ceil(text.length / 4)),
    contentHash: contentHashOf(text),
    effectiveDate: null,
    acl: { readableBy: [...groups], existence },
    embedding: EMBEDDING,
  });
  return { chunk, text, vector: vectorOf(text, EMBEDDING.dimension) };
}

/**
 * A corpus shaped so that both leaks are exhibited rather than described.
 *
 * `retention` is in every document, and the finance documents are shorter, so BM25's length
 * normalisation puts them at the top of a corpus-wide ranking — which is what makes the truncation
 * leak visible when a post-filter then removes them.
 *
 * `ledger` is rare among the documents Alice can read and common among the ones she cannot;
 * `policy` is the reverse. Their inverse document frequencies therefore swap places depending on
 * which half of the corpus is counted, which is the shape ADR 0004 is about.
 */
const ENGINEERING_ROWS: readonly IndexRow[] = [
  makeRow("eng_a", 0, "policy policy policy retention handbook guidance", [ENGINEERING]),
  makeRow("eng_b", 0, "ledger retention handbook guidance escalation", [ENGINEERING]),
  makeRow("eng_c", 0, "policy guidance retention handbook onboarding", [ENGINEERING]),
  makeRow("eng_d", 0, "policy handbook retention onboarding escalation", [ENGINEERING]),
  makeRow("eng_e", 0, "policy escalation retention guidance onboarding", [ENGINEERING]),
];

const FINANCE_ROWS: readonly IndexRow[] = ["a", "b", "c", "d", "e"].map((suffix) =>
  makeRow(`fin_${suffix}`, 0, "ledger ledger ledger retention", [FINANCE]),
);

const HIDDEN_ROW = makeRow("fin_secret", 0, "ledger retention acquisition", [FINANCE], "hidden");

const ALL_ROWS: readonly IndexRow[] = [...ENGINEERING_ROWS, ...FINANCE_ROWS, HIDDEN_ROW];

/** Present in every document, so a corpus-wide ranking is decided by length normalisation. */
const SHARED_QUERY = "retention";
/** Two terms whose rarity is inverted between the two halves of the corpus. */
const QUERY = "ledger policy";

function lexical(rows: readonly IndexRow[] = ALL_ROWS) {
  const index = inMemoryLexicalIndex(SCHEMA);
  void index.upsert(rows);
  return index;
}

function forbidden(predicate: CompiledPredicate): ReadonlySet<ChunkId> {
  const held = new Set(predicate.groups);
  return new Set(
    ALL_ROWS.filter((row) => !row.chunk.acl.readableBy.some((group) => held.has(group))).map(
      (row) => row.chunk.chunkId,
    ),
  );
}

/* ------------------------------------------------------- the implementations PRD 6.2 rejects */

/** BM25 over a fixed document set. Shared by the two rejected searches below. */
function bm25(
  documents: readonly { readonly row: IndexRow; readonly tokens: readonly string[] }[],
  terms: readonly string[],
): readonly { readonly row: IndexRow; readonly score: number }[] {
  const count = documents.length;
  const averageLength = documents.reduce((sum, entry) => sum + entry.tokens.length, 0) / count;
  const df = new Map<string, number>();
  for (const entry of documents) {
    for (const term of new Set(entry.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  return documents.map((entry) => {
    let score = 0;
    for (const term of terms) {
      const frequency = entry.tokens.filter((token) => token === term).length;
      if (frequency === 0) continue;
      const frequencyInCorpus = df.get(term) ?? 0;
      const idf = Math.log(1 + (count - frequencyInCorpus + 0.5) / (frequencyInCorpus + 0.5));
      const normalisation =
        frequency + 1.2 * (1 - 0.75 + (0.75 * entry.tokens.length) / averageLength);
      score += idf * ((frequency * 2.2) / normalisation);
    }
    return { row: entry.row, score };
  });
}

/** Rejected: statistics over the whole corpus, then filter. See ADR 0004. */
function corpusWideSearch(query: string, predicate: CompiledPredicate, limit: number) {
  const held = new Set(predicate.groups);
  const documents = ALL_ROWS.map((row) => ({ row, tokens: tokenise(row.text) }));
  const scored = bm25(documents, tokenise(query)).filter(
    (entry) => entry.score > 0 && entry.row.chunk.acl.readableBy.some((group) => held.has(group)),
  );
  return rankBy(scored, limit);
}

/** Rejected: score everything, take the top k, then drop what may not be read. PRD 6.2. */
function postFilterSearch(query: string, predicate: CompiledPredicate, limit: number) {
  const held = new Set(predicate.groups);
  const documents = ALL_ROWS.map((row) => ({ row, tokens: tokenise(row.text) }));
  const scored = bm25(documents, tokenise(query)).filter((entry) => entry.score > 0);

  const examined = scored.map((entry) => entry.row.chunk.chunkId);
  const top = rankBy(scored, limit);
  const survivors = top.filter((candidate) => {
    const row = ALL_ROWS.find((entry) => entry.chunk.chunkId === candidate.chunkId);
    return row?.chunk.acl.readableBy.some((group) => held.has(group)) ?? false;
  });

  return { examined, returned: survivors };
}

/* ------------------------------------------------------------------------------- predicate */

describe("compiling the permission predicate (PRD 6.2)", () => {
  it("sorts and deduplicates the principal's groups", () => {
    const predicate = compilePredicate({
      id: ALICE.id,
      groups: [PLATFORM, ENGINEERING, PLATFORM],
    });
    expect(predicate.groups).toEqual([ENGINEERING, PLATFORM]);
  });

  it("compiles an empty group set to deny-all, not to an absent filter", () => {
    // PRD 6.1: empty means "reads nothing" and never "reads everything".
    expect(compilePredicate(NOBODY).filter).toEqual({ op: "deny-all" });
  });

  it("renders itself for the audit record PRD 6.6 requires", () => {
    expect(renderPredicate(compilePredicate(ALICE).filter)).toBe(
      "any-group(grp_engineering, grp_platform)",
    );
    expect(renderPredicate({ op: "deny-all" })).toBe("deny-all");
  });

  it("carries a group-set hash, so a cache key cannot be built without one", () => {
    expect(compilePredicate(ALICE).groupSetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

/* ---------------------------------------------------------------------------------- schema */

describe("schema migration", () => {
  it("reports no work when the schemas agree", () => {
    expect(planMigration(SCHEMA, currentSchema(EMBEDDING)).kind).toBe("none");
  });

  it("classifies an embedding model change as a reindex", () => {
    const plan = planMigration(SCHEMA, currentSchema({ id: "other-embedder", dimension: 8 }));
    expect(plan.kind).toBe("reindex");
    expect(plan.reason).toContain("not comparable");
  });

  it("classifies a dimension change as a reindex too", () => {
    expect(planMigration(SCHEMA, currentSchema({ id: "fake-embedder", dimension: 16 })).kind).toBe(
      "reindex",
    );
  });

  it("allows an added field in place", () => {
    const plan = planMigration(SCHEMA, {
      ...SCHEMA,
      version: 2,
      fields: [...SCHEMA.fields, "language"],
    });
    expect(plan.kind).toBe("in-place");
    expect(plan.addedFields).toEqual(["language"]);
  });

  it("refuses a downgrade", () => {
    const plan = planMigration({ ...SCHEMA, version: 2 }, SCHEMA);
    expect(plan.kind).toBe("refused");
    expect(plan.reason).toContain("Downgrading");
  });

  it("refuses to remove a field PRD 4.4 requires", () => {
    const plan = planMigration(SCHEMA, {
      ...SCHEMA,
      fields: SCHEMA.fields.filter((field) => field !== "embedding"),
    });
    expect(plan.kind).toBe("refused");
    expect(plan.removedFields).toEqual(["embedding"]);
  });

  it("refuses a mixed-model comparison loudly", () => {
    try {
      assertSameModel(SCHEMA, { id: "other", dimension: 8 }, "the query vector");
      expect.unreachable("a mixed-model query must be refused");
    } catch (error) {
      expect((error as AtlasOpsError).code).toBe("MIXED_EMBEDDING_MODEL");
    }
  });
});

/* -------------------------------------------------------------------------- the pre-filter */

describe("the pre-filter is where the rows are, not where the filter is (PRD 6.2)", () => {
  it("examines no row the principal cannot read", async () => {
    // The assertion that distinguishes a pre-filter from a post-filter. Checking the returned
    // candidates would pass for both.
    const index = lexical();
    const predicate = compilePredicate(ALICE);
    await index.search({ query: QUERY, predicate, limit: 10 });

    const off = forbidden(predicate);
    expect(index.lastScan().filter((chunkId) => off.has(chunkId))).toEqual([]);
  });

  it("returns only readable candidates", async () => {
    const index = lexical();
    const predicate = compilePredicate(ALICE);
    const candidates = await index.search({ query: QUERY, predicate, limit: 10 });

    expect(candidates.length).toBeGreaterThan(0);
    const off = forbidden(predicate);
    expect(candidates.filter((candidate) => off.has(candidate.chunkId))).toEqual([]);
  });

  it("returns nothing and scans nothing for a principal with no groups", async () => {
    const index = lexical();
    const predicate = compilePredicate(NOBODY);
    expect(await index.search({ query: QUERY, predicate, limit: 10 })).toEqual([]);
    expect(index.lastScan()).toEqual([]);
  });

  it("counts a chunk readable through two of the principal's groups once", () => {
    const store = rowStore();
    store.upsert([makeRow("both", 0, "shared passage", [ENGINEERING, PLATFORM])]);
    expect(store.visible(compilePredicate(ALICE))).toHaveLength(1);
  });

  it("drops a row out of a group's posting list when it is relabelled", () => {
    const store = rowStore();
    store.upsert([makeRow("doc", 0, "passage", [ENGINEERING])]);
    expect(store.visible(compilePredicate(ALICE))).toHaveLength(1);

    // A revocation: the same chunk, relabelled to a group Alice does not hold.
    store.upsert([makeRow("doc", 0, "passage", [FINANCE])]);
    expect(store.visible(compilePredicate(ALICE))).toEqual([]);
    expect(store.lastScan()).toEqual([]);
  });

  it("removes purged rows from the postings, not only from the row map", () => {
    const store = rowStore();
    const row = makeRow("doc", 0, "passage", [ENGINEERING]);
    store.upsert([row]);

    const removed = store.purge([
      { sourceId: row.chunk.sourceId, sourceVersionId: row.chunk.sourceVersionId },
    ]);

    expect(removed).toHaveLength(1);
    expect(store.size()).toBe(0);
    expect(store.visible(compilePredicate(ALICE))).toEqual([]);
  });

  it("makes a chunk with an empty ACL unreachable by everybody", () => {
    const store = rowStore();
    store.upsert([makeRow("orphan", 0, "passage", [])]);
    expect(store.visible(compilePredicate(ALICE))).toEqual([]);
    expect(store.size()).toBe(1);
  });
});

describe("the post-filter PRD 6.2 rejects, demonstrated", () => {
  it("scores documents the principal cannot read, where the pre-filter does not", async () => {
    const predicate = compilePredicate(ALICE);
    const off = forbidden(predicate);

    const rejected = postFilterSearch(SHARED_QUERY, predicate, 5);
    const index = lexical();
    await index.search({ query: SHARED_QUERY, predicate, limit: 5 });

    expect(rejected.examined.filter((chunkId) => off.has(chunkId)).length).toBeGreaterThan(0);
    expect(index.lastScan().filter((chunkId) => off.has(chunkId))).toEqual([]);
  });

  it("leaks through truncation: the principal gets a shorter result set", async () => {
    // PRD 6.2's first objection. The length of what survives tells Alice how much she was not
    // allowed to see, without a single forbidden row being returned.
    const predicate = compilePredicate(ALICE);
    const rejected = postFilterSearch(SHARED_QUERY, predicate, 5);
    const index = lexical();
    const candidates = await index.search({ query: SHARED_QUERY, predicate, limit: 5 });

    expect(rejected.returned.length).toBeLessThan(5);
    expect(candidates).toHaveLength(5);
  });
});

describe("corpus-wide term statistics, demonstrated (ADR 0004)", () => {
  it("re-orders the documents the principal can read", async () => {
    // No forbidden row is returned by either implementation. The ordering of the permitted ones
    // still changes, because IDF carried information about the restricted half of the corpus.
    const predicate = compilePredicate(ALICE);
    const index = lexical();

    const ours = await index.search({ query: QUERY, predicate, limit: 5 });
    const rejected = corpusWideSearch(QUERY, predicate, 5);

    expect(ours[0]?.chunkId).not.toBe(rejected[0]?.chunkId);
    // Concretely: `ledger` is discriminating among what Alice can read, and `policy` is not.
    expect(ours[0]?.text).toContain("ledger");
    expect(rejected[0]?.text).toContain("policy");
  });

  it("ranks the passage with the rarer term first, judged among what Alice can read", async () => {
    const index = lexical();
    const candidates = await index.search({
      query: QUERY,
      predicate: compilePredicate(ALICE),
      limit: 5,
    });
    // "ledger" appears in one document Alice can read and in every one she cannot.
    expect(candidates[0]?.text).toContain("ledger");
  });
});

/* --------------------------------------------------------------------------------- lexical */

describe("the lexical arm", () => {
  it("returns no more than the limit, ranked from one", async () => {
    const index = lexical();
    const candidates = await index.search({
      query: "policy guidance handbook",
      predicate: compilePredicate(ALICE),
      limit: 3,
    });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.rank)).toEqual([1, 2, 3]);
  });

  it("returns nothing when no passage contains a query term", async () => {
    const index = lexical();
    expect(
      await index.search({
        query: "photosynthesis",
        predicate: compilePredicate(ALICE),
        limit: 5,
      }),
    ).toEqual([]);
  });

  it("returns nothing for an empty query rather than everything", async () => {
    const index = lexical();
    expect(
      await index.search({ query: "   ", predicate: compilePredicate(ALICE), limit: 5 }),
    ).toEqual([]);
  });

  it("breaks ties on the identifier, so a rebuild does not reorder the results", () => {
    const rows = [
      makeRow("tie_b", 0, "same", [ENGINEERING]),
      makeRow("tie_a", 0, "same", [ENGINEERING]),
    ];
    const forward = rankBy(
      rows.map((row) => ({ row, score: 1 })),
      2,
    );
    const backward = rankBy(
      [...rows].reverse().map((row) => ({ row, score: 1 })),
      2,
    );
    expect(forward.map((candidate) => candidate.chunkId)).toEqual(
      backward.map((candidate) => candidate.chunkId),
    );
  });

  it("carries the passage and its heading path, so a citation needs no second lookup", async () => {
    const index = lexical();
    const candidates = await index.search({
      query: QUERY,
      predicate: compilePredicate(ALICE),
      limit: 1,
    });
    expect(candidates[0]?.text.length).toBeGreaterThan(0);
    expect(candidates[0]?.headingPath.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- existence probe */

describe("the existence probe (PRD 6.4)", () => {
  it("counts withheld material from visible sources", async () => {
    const index = lexical();
    const probe = await index.probeWithheld({
      query: SHARED_QUERY,
      predicate: compilePredicate(ALICE),
      limit: 0,
    });

    expect(probe.visibleWithheld).toBeGreaterThan(0);
    expect(probe.excluded).toContain("visible");
  });

  it("does not count material from hidden sources", async () => {
    const index = lexical([...ENGINEERING_ROWS, HIDDEN_ROW]);
    const probe = await index.probeWithheld({
      query: "acquisition",
      predicate: compilePredicate(ALICE),
      limit: 0,
    });

    expect(probe.visibleWithheld).toBe(0);
    expect(probe.excluded).toEqual(["hidden"]);
  });

  it("produces wording a hidden source cannot be distinguished from absence by", async () => {
    // The oracle PRD 6.4 exists to close: the message for "hidden material was excluded" and the
    // message for "nothing was found" have to be the same bytes.
    const withHidden = lexical([...ENGINEERING_ROWS, HIDDEN_ROW]);
    const withoutIt = lexical(ENGINEERING_ROWS);

    const probeA = await withHidden.probeWithheld({
      query: "acquisition",
      predicate: compilePredicate(ALICE),
      limit: 0,
    });
    const probeB = await withoutIt.probeWithheld({
      query: "acquisition",
      predicate: compilePredicate(ALICE),
      limit: 0,
    });

    expect(abstentionMessage(outcomeFor(probeA.excluded))).toBe(
      abstentionMessage(outcomeFor(probeB.excluded)),
    );
  });

  it("returns nothing rankable — only counts and policies", async () => {
    const index = lexical();
    const probe = await index.probeWithheld({
      query: SHARED_QUERY,
      predicate: compilePredicate(ALICE),
      limit: 0,
    });
    expect(Object.keys(probe).sort()).toEqual(["excluded", "visibleWithheld"]);
  });
});

/* ---------------------------------------------------------------------------------- vector */

describe("the vector arm", () => {
  it("applies the same pre-filter as the lexical arm", async () => {
    const index = inMemoryVectorIndex(SCHEMA);
    await index.upsert(ALL_ROWS);
    const predicate = compilePredicate(ALICE);

    const candidates = await index.search({
      vector: vectorOf("ledger retention", EMBEDDING.dimension),
      embedding: EMBEDDING,
      predicate,
      limit: 10,
    });

    const off = forbidden(predicate);
    expect(index.lastScan().filter((chunkId) => off.has(chunkId))).toEqual([]);
    expect(candidates.filter((candidate) => off.has(candidate.chunkId))).toEqual([]);
  });

  it("ranks the exact passage first", async () => {
    const index = inMemoryVectorIndex(SCHEMA);
    await index.upsert(ENGINEERING_ROWS);
    const target = ENGINEERING_ROWS[1];

    const candidates = await index.search({
      vector: vectorOf(target!.text, EMBEDDING.dimension),
      embedding: EMBEDDING,
      predicate: compilePredicate(ALICE),
      limit: 3,
    });

    expect(candidates[0]?.chunkId).toBe(target!.chunk.chunkId);
    expect(candidates[0]?.score).toBeCloseTo(1, 10);
  });

  it("refuses a query vector from another model", async () => {
    const index = inMemoryVectorIndex(SCHEMA);
    await index.upsert(ENGINEERING_ROWS);

    await expect(
      index.search({
        vector: vectorOf("anything", 8),
        embedding: { id: "another-embedder", dimension: 8 },
        predicate: compilePredicate(ALICE),
        limit: 3,
      }),
    ).rejects.toThrow(/plausible nonsense/);
  });

  it("refuses a row whose vector is the wrong width", async () => {
    const index = inMemoryVectorIndex(SCHEMA);
    const row = ENGINEERING_ROWS[0];
    await expect(index.upsert([{ ...row!, vector: [1, 0, 0] }])).rejects.toThrow(
      /3-dimension vector/,
    );
  });

  it("normalises rather than assuming unit length", () => {
    // The in-repo fake produces unit vectors, so assuming it would pass every test here and
    // mis-rank against a provider that does not.
    expect(cosine([3, 0], [10, 0])).toBeCloseTo(1, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("drops a passage the query points away from", async () => {
    const index = inMemoryVectorIndex(SCHEMA);
    await index.upsert(ENGINEERING_ROWS);
    const candidates = await index.search({
      vector: vectorOf("anything at all", EMBEDDING.dimension),
      embedding: EMBEDDING,
      predicate: compilePredicate(ALICE),
      limit: 10,
    });
    expect(candidates.every((candidate) => candidate.score > 0)).toBe(true);
  });
});
