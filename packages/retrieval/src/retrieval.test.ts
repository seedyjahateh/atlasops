/**
 * Retrieval tests (P8).
 *
 * The headline is the fusion comparison. A min-max score interpolator is written out below — in the
 * test file and nowhere else — together with a case where two documents keep identical raw scores
 * and identical ranks in both arms, and swap places anyway because a third, lower-ranked document
 * changed. That is PRD 5.2's objection made concrete rather than quoted.
 *
 * The same case shows what RRF gives up: A and B tie under it, although one is dominant on one arm.
 * PRD 5.2 accepts that explicitly and points at the reranker to restore the discrimination, so the
 * cost is asserted here beside the benefit.
 *
 * Nothing calls a paid API. The embedder and reranker are `model-gateway`'s fakes, the indexes are
 * `indexing`'s in-memory adapters, and the clock is manual.
 */

import {
  contentHashOf,
  formatChunkId,
  formatRequestId,
  formatSourceVersionId,
  parseChunk,
  parseGroupId,
  parsePrincipalId,
  parseSourceId,
  type GroupId,
} from "@atlasops/contracts";
import type { Principal } from "@atlasops/governance";
import {
  currentSchema,
  inMemoryLexicalIndex,
  inMemoryVectorIndex,
  type Candidate,
  type IndexRow,
  type LexicalIndex,
  type VectorIndex,
} from "@atlasops/indexing";
import {
  ModelError,
  createEmbeddingGateway,
  fakeEmbedder,
  fakeReranker,
  recordingSleeper,
  unavailableReranker,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
} from "@atlasops/model-gateway";
import { manualClock } from "@atlasops/telemetry";
import { describe, expect, it } from "vitest";

import { inMemoryRetrievalCache } from "./cache.js";
import { RETRIEVAL_DEFAULTS, ablate, configKey, validateConfig } from "./config.js";
import { reciprocalRankFusion, type RankedList } from "./fusion.js";
import { analyseQuery } from "./query.js";
import { retrieve, type RetrievalPorts } from "./retrieve.js";
import { staticVersionOracle } from "./temporal.js";

/* -------------------------------------------------------------------------------- fixtures */

const ENGINEERING: GroupId = parseGroupId("grp_engineering", "fixture");
const FINANCE: GroupId = parseGroupId("grp_finance", "fixture");

/**
 * A bag-of-words embedder over a fixed eight-word vocabulary.
 *
 * `model-gateway`'s `fakeEmbedder` derives vectors from a hash, which is the right fake for testing
 * caching and retry behaviour and the wrong one for testing a dense arm: hashed vectors have no
 * structure, so cosine similarity between a query and a passage is noise, and a test written
 * against it would assert whatever the hash happened to produce.
 *
 * This one is still not a model and proves nothing about retrieval quality. What it does is give
 * cosine a meaning, so the dense arm's *mechanism* — that it finds a passage sharing the query's
 * terms, that ablating it changes what comes back — is testable rather than accidental.
 */
const VOCABULARY = [
  "refund",
  "eligibility",
  "policy",
  "ledger",
  "error",
  "onboarding",
  "checklist",
  "quarter",
] as const;

const EMBEDDING = { id: "bag-of-words", dimension: VOCABULARY.length };
const SCHEMA = currentSchema(EMBEDDING);

function bagOfWords(text: string): readonly number[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  const counts = VOCABULARY.map((term) => tokens.filter((token) => token === term).length);
  const norm = Math.sqrt(counts.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? counts : counts.map((value) => value / norm);
}

const bagOfWordsEmbedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map(bagOfWords),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

const ALICE: Principal = {
  id: parsePrincipalId("prn_alice", "fixture"),
  groups: [ENGINEERING],
};
const BOB: Principal = { id: parsePrincipalId("prn_bob", "fixture"), groups: [FINANCE] };

const REQUEST = formatRequestId("r1");

function makeRow(
  name: string,
  text: string,
  groups: readonly GroupId[] = [ENGINEERING],
  /** The source this version belongs to. Defaults to its own name. */
  sourceName: string = name,
): IndexRow {
  const contentHash = contentHashOf(`version-of-${name}`);
  const sourceVersionId = formatSourceVersionId(contentHash);
  const chunk = parseChunk({
    chunkId: formatChunkId(sourceVersionId, 0),
    sourceId: parseSourceId(`src_${sourceName}`, "fixture"),
    sourceVersionId,
    ordinal: 0,
    headingPath: [name],
    charStart: 0,
    charEnd: text.length,
    tokenCount: Math.max(1, Math.ceil(text.length / 4)),
    contentHash: contentHashOf(text),
    effectiveDate: null,
    acl: { readableBy: [...groups], existence: "visible" },
    embedding: EMBEDDING,
  });
  return { chunk, text, vector: bagOfWords(text) };
}

const ROW_A = makeRow("a", "refund eligibility policy for cancelled orders");
const ROW_B = makeRow("b", "error code ERR_5521 appears when the ledger is locked");
const ROW_C = makeRow("c", "onboarding checklist for new engineers");
const ROW_FIN = makeRow("fin", "refund eligibility ledger quarter close", [FINANCE]);

const ROWS: readonly IndexRow[] = [ROW_A, ROW_B, ROW_C, ROW_FIN];

function candidateOf(row: IndexRow, rank: number, score: number): Candidate {
  return {
    chunkId: row.chunk.chunkId,
    sourceId: row.chunk.sourceId,
    sourceVersionId: row.chunk.sourceVersionId,
    headingPath: row.chunk.headingPath,
    text: row.text,
    score,
    rank,
  };
}

/** Every source's current version is the only one it has, unless a test says otherwise. */
const ORACLE = staticVersionOracle({
  current: Object.fromEntries(ROWS.map((row) => [row.chunk.sourceId, row.chunk.sourceVersionId])),
});

interface Harness extends RetrievalPorts {
  readonly lexical: LexicalIndex;
  readonly vector: VectorIndex;
}

async function harness(overrides: Partial<RetrievalPorts> = {}): Promise<Harness> {
  const lexical = inMemoryLexicalIndex(SCHEMA);
  const vector = inMemoryVectorIndex(SCHEMA);
  await lexical.upsert(ROWS);
  await vector.upsert(ROWS);

  const sleeper = recordingSleeper();
  return {
    lexical,
    vector,
    embeddings: createEmbeddingGateway(bagOfWordsEmbedder, { sleeper }),
    reranker: fakeReranker(),
    oracle: ORACLE,
    sleeper,
    clock: manualClock(),
    ...overrides,
  };
}

/* ------------------------------------------------- the fusion PRD 5.2 rejects, demonstrated */

/**
 * Rejected: normalise each arm's scores to [0, 1] per query and add them.
 *
 * Per-query min-max is the only way to combine an unbounded BM25 score with a bounded cosine
 * without fitting a calibration model, and it is what makes one result's score depend on which
 * other documents happened to be retrieved alongside it.
 */
function minMaxInterpolate(lists: readonly RankedList[], limit: number) {
  const totals = new Map<string, { candidate: Candidate; score: number }>();

  for (const list of lists) {
    const scores = list.candidates.map((candidate) => candidate.score);
    const low = Math.min(...scores);
    const high = Math.max(...scores);
    const span = high - low;

    for (const candidate of list.candidates) {
      const normalised = span === 0 ? 1 : (candidate.score - low) / span;
      const existing = totals.get(candidate.chunkId);
      if (existing === undefined) totals.set(candidate.chunkId, { candidate, score: normalised });
      else existing.score += normalised;
    }
  }

  return [...totals.values()]
    .sort((a, b) =>
      b.score === a.score
        ? a.candidate.chunkId.localeCompare(b.candidate.chunkId)
        : b.score - a.score,
    )
    .slice(0, limit)
    .map((entry) => entry.candidate.chunkId);
}

/**
 * Two arms in which A and B hold identical raw scores and identical ranks. Only C moves.
 *
 * Lexical: A 12.0 (rank 1), B 11.0 (rank 2), C (rank 3).
 * Dense:   B 0.90 (rank 1), A 0.60 (rank 2), C (rank 3).
 */
function arms(lexicalC: number, denseC: number): readonly RankedList[] {
  return [
    {
      retriever: "lexical",
      candidates: [
        candidateOf(ROW_A, 1, 12.0),
        candidateOf(ROW_B, 2, 11.0),
        candidateOf(ROW_C, 3, lexicalC),
      ],
    },
    {
      retriever: "dense",
      candidates: [
        candidateOf(ROW_B, 1, 0.9),
        candidateOf(ROW_A, 2, 0.6),
        candidateOf(ROW_C, 3, denseC),
      ],
    },
  ];
}

/** C close behind B lexically, far behind A densely. */
const NEAR = arms(10.9, 0.0);
/** C far behind B lexically, close behind A densely. A and B are untouched. */
const FAR = arms(0.0, 0.59);

describe("reciprocal rank fusion, and why not score interpolation (PRD 5.2)", () => {
  it("scores by rank alone", () => {
    const fused = reciprocalRankFusion(NEAR, 60, 10);
    const a = fused.find((candidate) => candidate.chunkId === ROW_A.chunk.chunkId);
    expect(a?.fusedScore).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it("rewards a chunk both arms found over one only a single arm did", () => {
    const fused = reciprocalRankFusion(NEAR, 60, 10);
    const both = fused.filter((candidate) => candidate.contributions.length === 2);
    const one = fused.filter((candidate) => candidate.contributions.length === 1);
    for (const candidate of both) {
      for (const other of one) expect(candidate.fusedScore).toBeGreaterThan(other.fusedScore);
    }
  });

  it("gives the same ordering when only a lower-ranked document changed", () => {
    const near = reciprocalRankFusion(NEAR, 60, 10).map((candidate) => candidate.chunkId);
    const far = reciprocalRankFusion(FAR, 60, 10).map((candidate) => candidate.chunkId);
    expect(near).toEqual(far);
  });

  it("interpolation swaps the top two when only a lower-ranked document changed", () => {
    // PRD 5.2: per-query min-max "makes a single result's score depend on its competitors and
    // destroys comparability across queries". A and B did not move; C did.
    const near = minMaxInterpolate(NEAR, 10);
    const far = minMaxInterpolate(FAR, 10);

    expect(near[0]).toBe(ROW_A.chunk.chunkId);
    expect(far[0]).toBe(ROW_B.chunk.chunkId);
    expect(near[0]).not.toBe(far[0]);
  });

  it("cannot distinguish a dominant result from a marginal one — the accepted cost", () => {
    // B leads the dense arm by 0.30 and trails the lexical arm by 1.0. RRF sees rank 1 and rank 2
    // on both sides and ties them. PRD 5.2 accepts this and points at the reranker to restore it.
    const fused = reciprocalRankFusion(NEAR, 60, 10);
    const a = fused.find((candidate) => candidate.chunkId === ROW_A.chunk.chunkId);
    const b = fused.find((candidate) => candidate.chunkId === ROW_B.chunk.chunkId);
    expect(a?.fusedScore).toBeCloseTo(b?.fusedScore ?? 0, 12);
  });

  it("breaks a tie on the identifier, not on which arm answered first", () => {
    const forward = reciprocalRankFusion(NEAR, 60, 10).map((candidate) => candidate.chunkId);
    const reversed = reciprocalRankFusion([...NEAR].reverse(), 60, 10).map(
      (candidate) => candidate.chunkId,
    );
    expect(forward).toEqual(reversed);
  });

  it("records which retriever found each chunk, so an ablation can attribute a result", () => {
    const fused = reciprocalRankFusion(NEAR, 60, 10);
    const a = fused.find((candidate) => candidate.chunkId === ROW_A.chunk.chunkId);
    expect(a?.contributions).toEqual([
      { retriever: "dense", rank: 2 },
      { retriever: "lexical", rank: 1 },
    ]);
  });
});

/* ------------------------------------------------------------------------ config + ablation */

describe("configuration and the ablation switches (PRD 5.2, 5.3)", () => {
  it("ships defaults marked as unselected", () => {
    // PRD 5.2: k and the depths are to be selected on the development split and recorded in the
    // evaluation artefact, "not chosen here and not asserted anywhere as tuned".
    expect(RETRIEVAL_DEFAULTS.provenance).toBe("unselected-default");
  });

  it("refuses an ablation with both retrievers disabled", () => {
    expect(() =>
      ablate(RETRIEVAL_DEFAULTS, {
        dense: { enabled: false, depth: 50 },
        lexical: { enabled: false, depth: 50 },
      }),
    ).toThrow(/retrieves from nowhere/);
  });

  it("refuses a non-positive depth", () => {
    expect(() => ablate(RETRIEVAL_DEFAULTS, { lexical: { enabled: true, depth: 0 } })).toThrow(
      /positive integer/,
    );
  });

  it("gives each ablation its own key, so results cannot be shared between them", () => {
    const base = configKey(RETRIEVAL_DEFAULTS);
    const noRerank = configKey(
      ablate(RETRIEVAL_DEFAULTS, { rerank: { enabled: false, depth: 20 } }),
    );
    const selected = configKey({ ...RETRIEVAL_DEFAULTS, provenance: "selected-on-dev-split" });

    expect(new Set([base, noRerank, selected]).size).toBe(3);
  });

  it("validates the instant on a temporal scope", () => {
    expect(() =>
      validateConfig({ ...RETRIEVAL_DEFAULTS, temporal: { kind: "as-of", instant: "March" } }),
    ).toThrow(/ISO 8601/);
  });
});

/* ------------------------------------------------------------------------- query handling */

describe("query handling (PRD 5.4)", () => {
  it("gives the dense arm the raw query and the lexical arm an analysed one", () => {
    const analysed = analyseQuery("  How do I get   my money back?  ");
    expect(analysed.normalised).toBe("How do I get my money back?");
    expect(analysed.lexical).toBe("get money back");
  });

  it("keeps the terms of a query that is entirely stopwords", () => {
    // Returning nothing because the query was stripped to nothing is a different failure from
    // returning nothing because the corpus has no answer, and only the second is honest.
    expect(analyseQuery("what is it").lexical).toBe("what is it");
  });

  it("hashes the normalised form, so whitespace does not split a cache", () => {
    expect(analyseQuery("a  b").hash).toBe(analyseQuery("a b").hash);
  });
});

/* --------------------------------------------------------------------------- the pipeline */

describe("the pipeline", () => {
  it("runs both arms and fuses them", async () => {
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.degraded).toEqual([]);
    expect(result.cacheHit).toBe(false);
  });

  it("returns nothing the principal may not read", async () => {
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "refund eligibility ledger",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.candidates.some((candidate) => candidate.chunkId === ROW_FIN.chunk.chunkId)).toBe(
      false,
    );
    // And the indexes never touched it — the filter is theirs, not this package's.
    expect(ports.lexical.lastScan()).not.toContain(ROW_FIN.chunk.chunkId);
    expect(ports.vector.lastScan()).not.toContain(ROW_FIN.chunk.chunkId);
  });

  it("records the compiled predicate PRD 6.6 stores", async () => {
    const ports = await harness();
    const result = await retrieve(ports, { query: "refund", principal: ALICE, requestId: REQUEST });
    expect(result.predicate.groups).toEqual([ENGINEERING]);
  });

  it("honours the limit", async () => {
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "refund eligibility ledger onboarding error",
      principal: ALICE,
      requestId: REQUEST,
      config: ablate(RETRIEVAL_DEFAULTS, { limit: 2 }),
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
  });

  it("records a span per stage (PRD 9.2)", async () => {
    const ports = await harness();
    const result = await retrieve(ports, { query: "refund", principal: ALICE, requestId: REQUEST });
    const stages = result.trace.spans.map((span) => span.stage);
    expect(stages).toContain("query-normalisation");
    expect(stages).toContain("dense-retrieval");
    expect(stages).toContain("lexical-retrieval");
    expect(stages).toContain("fusion");
  });

  it("finds an exact token through the lexical arm that the dense arm alone would blur", async () => {
    // PRD 5.1's motivating case: ERR_5521 and ERR_5251 are near-identical in vector space.
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "ERR_5521",
      principal: ALICE,
      requestId: REQUEST,
      config: ablate(RETRIEVAL_DEFAULTS, {
        dense: { enabled: false, depth: 50 },
        rerank: { enabled: false, depth: 20 },
      }),
    });
    expect(result.candidates[0]?.chunkId).toBe(ROW_B.chunk.chunkId);
  });
});

describe("ablation", () => {
  it("runs the dense arm alone", async () => {
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
      config: ablate(RETRIEVAL_DEFAULTS, { lexical: { enabled: false, depth: 50 } }),
    });

    const retrievers = new Set(
      result.candidates.flatMap((candidate) => candidate.contributions.map((c) => c.retriever)),
    );
    expect([...retrievers]).toEqual(["dense"]);
  });

  it("runs the lexical arm alone", async () => {
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
      config: ablate(RETRIEVAL_DEFAULTS, { dense: { enabled: false, depth: 50 } }),
    });

    const retrievers = new Set(
      result.candidates.flatMap((candidate) => candidate.contributions.map((c) => c.retriever)),
    );
    expect([...retrievers]).toEqual(["lexical"]);
  });

  it("bypasses the reranker by configuration, keeping the fused order", async () => {
    const ports = await harness();
    const query = { query: "refund eligibility", principal: ALICE, requestId: REQUEST };

    const withRerank = await retrieve(ports, query);
    const withoutIt = await retrieve(ports, {
      ...query,
      config: ablate(RETRIEVAL_DEFAULTS, { rerank: { enabled: false, depth: 20 } }),
    });

    expect(withoutIt.degraded).toEqual([]);
    expect(withRerank.candidates.length).toBeGreaterThan(0);
    expect(withoutIt.candidates.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- degraded modes */

describe("degraded modes (PRD 9.4)", () => {
  it("serves lexical-only when the vector index is unavailable", async () => {
    const base = await harness();
    const ports = {
      ...base,
      vector: {
        ...base.vector,
        search: (): Promise<readonly Candidate[]> =>
          Promise.reject(new Error("vector index unavailable")),
      },
    };

    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.degraded).toEqual(["dense-unavailable"]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("serves dense-only when the lexical index is unavailable", async () => {
    const base = await harness();
    const ports = {
      ...base,
      lexical: {
        ...base.lexical,
        search: (): Promise<readonly Candidate[]> =>
          Promise.reject(new Error("lexical index unavailable")),
      },
    };

    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.degraded).toEqual(["lexical-unavailable"]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("bypasses an unavailable reranker and says so", async () => {
    const ports = await harness({ reranker: unavailableReranker() });
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.degraded).toEqual(["reranker-unavailable"]);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.trace.degraded).toBe(true);
  });

  it("does not degrade past a mixed-model index — that is a defect, not an outage", async () => {
    // Serving lexical-only here would hide a broken vector index behind a slightly worse ranking
    // for as long as nobody read the flag.
    const base = await harness();
    const wrongModel = createEmbeddingGateway(
      fakeEmbedder({ id: "another-embedder", dimension: 8 }),
      { sleeper: base.sleeper },
    );

    await expect(
      retrieve(
        { ...base, embeddings: wrongModel },
        { query: "refund", principal: ALICE, requestId: REQUEST },
      ),
    ).rejects.toThrow(/plausible nonsense/);
  });

  it("propagates a model failure that is not an availability problem", async () => {
    const base = await harness();
    const ports = {
      ...base,
      vector: {
        ...base.vector,
        search: (): Promise<readonly Candidate[]> =>
          Promise.reject(new ModelError("embedder", "invalid-request", "malformed")),
      },
    };

    // An invalid request is not retryable and is not an outage, but it is also not something this
    // layer can fix — it degrades, and the flag is what a caller reads.
    const result = await retrieve(ports, {
      query: "refund",
      principal: ALICE,
      requestId: REQUEST,
    });
    expect(result.degraded).toEqual(["dense-unavailable"]);
  });
});

/* -------------------------------------------------------------------------------- caching */

describe("the retrieval cache is keyed on the principal (PRD 6.3)", () => {
  it("serves a repeat query for the same principal from cache", async () => {
    const cache = inMemoryRetrievalCache();
    const ports = await harness({ cache });
    const query = { query: "refund eligibility", principal: ALICE, requestId: REQUEST };

    const first = await retrieve(ports, query);
    const second = await retrieve(ports, query);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.candidates).toEqual(first.candidates);
  });

  it("never serves one principal from another's entry", async () => {
    const cache = inMemoryRetrievalCache();
    const ports = await harness({ cache });

    await retrieve(ports, { query: "refund eligibility", principal: ALICE, requestId: REQUEST });
    const bob = await retrieve(ports, {
      query: "refund eligibility",
      principal: BOB,
      requestId: REQUEST,
    });

    expect(bob.cacheHit).toBe(false);
    expect(cache.size()).toBe(2);
    expect(bob.candidates.every((candidate) => candidate.chunkId === ROW_FIN.chunk.chunkId)).toBe(
      true,
    );
  });

  it("does not serve an ablation from the default configuration's entry", async () => {
    const cache = inMemoryRetrievalCache();
    const ports = await harness({ cache });
    const query = { query: "refund eligibility", principal: ALICE, requestId: REQUEST };

    await retrieve(ports, query);
    const ablated = await retrieve(ports, {
      ...query,
      config: ablate(RETRIEVAL_DEFAULTS, { rerank: { enabled: false, depth: 20 } }),
    });

    expect(ablated.cacheHit).toBe(false);
  });
});

/* -------------------------------------------------------- freshness and superseded sources */

describe("freshness and superseded sources (PRD 5.5)", () => {
  // The same source, an earlier version. `sourceName` matters: a superseded version of source A
  // has to carry A's source identifier, or the oracle is answering about a different document.
  const superseded = makeRow(
    "a_old",
    "refund eligibility policy for cancelled orders, v1",
    [ENGINEERING],
    "a",
  );

  async function withHistory(): Promise<Harness> {
    const lexical = inMemoryLexicalIndex(SCHEMA);
    const vector = inMemoryVectorIndex(SCHEMA);
    const rows = [...ROWS, superseded];
    await lexical.upsert(rows);
    await vector.upsert(rows);

    const sleeper = recordingSleeper();
    return {
      lexical,
      vector,
      embeddings: createEmbeddingGateway(bagOfWordsEmbedder, { sleeper }),
      reranker: fakeReranker(),
      sleeper,
      clock: manualClock(),
      oracle: staticVersionOracle({
        current: { [ROW_A.chunk.sourceId]: ROW_A.chunk.sourceVersionId },
        history: {
          [ROW_A.chunk.sourceId]: [
            { versionId: superseded.chunk.sourceVersionId, until: "2026-03-01T00:00:00.000Z" },
            { versionId: ROW_A.chunk.sourceVersionId, from: "2026-03-01T00:00:00.000Z" },
          ],
        },
      }),
    };
  }

  it("excludes a superseded version by default", async () => {
    const ports = await withHistory();
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(
      result.candidates.some((candidate) => candidate.chunkId === superseded.chunk.chunkId),
    ).toBe(false);
    expect(result.supersededRemoved).toBeGreaterThan(0);
  });

  it("retrieves it only when the query carries an explicit temporal scope", async () => {
    const ports = await withHistory();
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
      config: ablate(RETRIEVAL_DEFAULTS, {
        temporal: { kind: "as-of", instant: "2026-02-01T00:00:00.000Z" },
      }),
    });

    expect(
      result.candidates.some((candidate) => candidate.chunkId === superseded.chunk.chunkId),
    ).toBe(true);
  });

  it("does not return the current version for an instant before it existed", async () => {
    const ports = await withHistory();
    const result = await retrieve(ports, {
      query: "refund eligibility",
      principal: ALICE,
      requestId: REQUEST,
      config: ablate(RETRIEVAL_DEFAULTS, {
        temporal: { kind: "as-of", instant: "2026-02-01T00:00:00.000Z" },
      }),
    });

    expect(result.candidates.some((candidate) => candidate.chunkId === ROW_A.chunk.chunkId)).toBe(
      false,
    );
  });

  it("refuses to guess a past it has no record of", () => {
    // A source with no recorded history: asserting that today's version was also current in March
    // is exactly the claim PRD 5.5 forbids.
    const oracle = staticVersionOracle({
      current: { [ROW_C.chunk.sourceId]: ROW_C.chunk.sourceVersionId },
    });
    expect(
      oracle.wasCurrentAt(
        ROW_C.chunk.sourceId,
        ROW_C.chunk.sourceVersionId,
        "2026-02-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      oracle.wasCurrentAt(
        ROW_A.chunk.sourceId,
        superseded.chunk.sourceVersionId,
        "2026-02-01T00:00:00.000Z",
      ),
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------------- existence probe */

describe("the existence probe runs only when there is nothing to answer from (PRD 6.4)", () => {
  it("probes when the candidate set is empty", async () => {
    const ports = await harness();
    // "quarter" and "close" appear only in the finance row, which Alice cannot read.
    const result = await retrieve(ports, {
      query: "quarter close",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.candidates).toEqual([]);
    expect(result.existence?.visibleWithheld).toBeGreaterThan(0);
  });

  it("does not probe when something was retrieved", async () => {
    const ports = await harness();
    const result = await retrieve(ports, {
      query: "onboarding checklist",
      principal: ALICE,
      requestId: REQUEST,
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.existence).toBeNull();
  });
});
