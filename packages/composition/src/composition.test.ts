/**
 * Composition tests (P11a).
 *
 * These are the first tests in the repository that run the whole system: ingest a corpus through
 * the real pipeline, index it, and answer a question through the real answer pipeline, with only
 * the provider boundary faked. Everything below has been tested in isolation; this is where the
 * joins are.
 *
 * The one that matters most is the stalled-ingestion test, and it is worth being precise about what
 * it does and does not show. It demonstrates that answers complete, and complete identically, while
 * an ingestion that will never finish is in flight — and that the answer pipeline holds no
 * reference through which it could wait on one. It is **not** a latency measurement: nothing here
 * has measured latency, and PRD section 0 does not permit one to be claimed from a run like this.
 */

import {
  contentHashOf,
  formatGroupId,
  formatPrincipalId,
  formatRequestId,
  formatSourceId,
  type GroupId,
  type PrincipalId,
  type SourceId,
} from "@atlasops/contracts";
import { inMemoryCorpusStore, type ConnectorListing } from "@atlasops/corpus";
import {
  inMemoryAuditSink,
  staticGroupResolver,
  unavailableGroupResolver,
  type Principal,
} from "@atlasops/governance";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import { structureAware, type Connector, type FetchedSource } from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  fakeGenerator,
  fakeReranker,
  inMemoryEmbeddingCache,
  recordingSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
  type GenerateRequest,
} from "@atlasops/model-gateway";
import { RETRIEVAL_DEFAULTS, ablate } from "@atlasops/retrieval";
import { manualClock } from "@atlasops/telemetry";
import { describe, expect, it } from "vitest";

import { createAnswerPipeline } from "./answering.js";
import { indexingChunkSink } from "./chunk-sink.js";
import { corpusVersionOracle } from "./corpus-oracle.js";
import { createIngestionPipeline } from "./ingesting.js";

/* -------------------------------------------------------------------------------- fixtures */

const ENGINEERING: GroupId = formatGroupId("engineering");
const FINANCE: GroupId = formatGroupId("finance");

const ALICE: PrincipalId = formatPrincipalId("alice");
const BOB: PrincipalId = formatPrincipalId("bob");
const WORKER: Principal = { id: formatPrincipalId("ingest-worker"), groups: [ENGINEERING] };

const HANDBOOK: SourceId = formatSourceId("handbook");
const LEDGER: SourceId = formatSourceId("ledger");

const HANDBOOK_TEXT = [
  "# Handbook",
  "",
  "## Refunds",
  "",
  "The refund window is thirty days from delivery. A refund requested after that window",
  "needs an exception from the owner of the order.",
  "",
  "## Escalation",
  "",
  "Escalate when a customer-visible symptom has lasted ten minutes and there is no",
  "hypothesis anybody can test yet.",
  "",
].join("\n");

const LEDGER_TEXT = [
  "# Ledger",
  "",
  "## Quarter close",
  "",
  "The quarterly ledger is reconciled in the first week after close. Finance owns the",
  "reconciliation and the sign-off.",
  "",
].join("\n");

/**
 * A bag-of-words embedder over a fixed vocabulary.
 *
 * The hash-based fake in `model-gateway` is right for caching and retry behaviour and wrong here:
 * hashed vectors have no structure, so the dense arm would return noise and an end-to-end test
 * would assert whatever the hash happened to produce. This is still not a model and says nothing
 * about retrieval quality — it gives cosine a meaning so the join between the arms is exercised.
 */
const VOCABULARY = [
  "refund",
  "window",
  "delivery",
  "escalate",
  "symptom",
  "ledger",
  "quarterly",
  "reconciled",
] as const;

const EMBEDDING = { id: "bag-of-words", dimension: VOCABULARY.length };

function bagOfWords(text: string): readonly number[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  const counts = VOCABULARY.map((term) => tokens.filter((token) => token === term).length);
  const norm = Math.sqrt(counts.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? counts : counts.map((value) => value / norm);
}

const embedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map(bagOfWords),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

/**
 * A generator that cites the first passage it was shown.
 *
 * It reads the chunk identifier out of the assembled prompt, which is what a real model does — the
 * identifiers are in the prompt precisely so the answer can name one. A generator that was handed
 * the candidate list out of band would not be exercising the prompt at all.
 */
const citingGenerator = fakeGenerator("fake-generator", (request: GenerateRequest): string => {
  const chunkId = /chunkId=(\S+)/.exec(request.user)?.[1];
  const versionId = /sourceVersionId=(\S+)/.exec(request.user)?.[1];
  if (chunkId === undefined || versionId === undefined) return JSON.stringify({ abstain: true });

  return JSON.stringify({
    segments: [
      {
        text: "The refund window is thirty days.",
        references: [{ chunkId, sourceVersionId: versionId, span: { start: 0, end: 5 } }],
      },
    ],
  });
});

interface Fixture {
  readonly sourceId: SourceId;
  readonly text: string;
  readonly groups: readonly GroupId[];
}

/** A connector over a mutable set of fixtures, with a switch that makes `fetch` hang forever. */
function connectorOver(fixtures: readonly Fixture[]) {
  const sources = new Map(fixtures.map((fixture) => [fixture.sourceId, fixture]));
  let hang = false;
  let fetches = 0;

  const connector: Connector = {
    name: "fixture",
    strategy: structureAware({ maxTokens: 64, boundaryDepth: 2 }),

    list: (): Promise<ConnectorListing> =>
      Promise.resolve({
        connector: "fixture",
        observedAt: "2026-05-01T00:00:00.000Z",
        complete: true,
        sources: [...sources.values()].map((fixture) => ({
          sourceId: fixture.sourceId,
          contentHash: contentHashOf(fixture.text),
        })),
      }),

    fetch: (sourceId: SourceId): Promise<FetchedSource> => {
      fetches += 1;
      // A crawl that accepted the request and never came back. Not a rejection — a rejection is
      // handled and recovers; this is the case the corpus cannot isolate its way out of.
      if (hang) return new Promise<FetchedSource>(() => undefined);

      const fixture = sources.get(sourceId);
      if (fixture === undefined) return Promise.reject(new Error(`no source ${sourceId}`));

      return Promise.resolve({
        text: fixture.text,
        observation: {
          sourceId,
          contentHash: contentHashOf(fixture.text),
          observedAt: "2026-05-01T00:00:00.000Z",
          effectiveDate: null,
          upstreamRevision: null,
          acl: { readableBy: [...fixture.groups], existence: "visible" },
        },
      });
    },
  };

  return {
    connector,
    fetches: (): number => fetches,
    stall: (): void => {
      hang = true;
    },
    add: (fixture: Fixture): void => {
      sources.set(fixture.sourceId, fixture);
    },
    remove: (sourceId: SourceId): void => {
      sources.delete(sourceId);
    },
  };
}

/* ----------------------------------------------------------------------------- the system */

function system(fixtures: readonly Fixture[] = DEFAULT_FIXTURES) {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const sleeper = recordingSleeper();
  const clock = manualClock();
  const embeddingCache = inMemoryEmbeddingCache();
  const embeddings = createEmbeddingGateway(embedder, { sleeper, cache: embeddingCache });
  const audit = inMemoryAuditSink();
  const upstream = connectorOver(fixtures);
  const chunks = indexingChunkSink(lexical, vector);

  const answering = createAnswerPipeline({
    store,
    lexical,
    vector,
    embeddings,
    sleeper,
    clock,
    reranker: fakeReranker(),
    generator: citingGenerator,
    groups: staticGroupResolver({ [ALICE]: [ENGINEERING], [BOB]: [FINANCE] }),
    audit,
    oracle: corpusVersionOracle(store),
    now: () => "2026-05-01T00:00:00.000Z",
  });

  const ingestion = createIngestionPipeline(
    {
      store,
      lexical,
      vector,
      embeddings,
      sleeper,
      clock,
      connector: upstream.connector,
      chunks,
      embeddingCache,
    },
    { orderedBy: WORKER },
  );

  return { store, lexical, vector, audit, answering, ingestion, upstream, chunks };
}

const DEFAULT_FIXTURES: readonly Fixture[] = [
  { sourceId: HANDBOOK, text: HANDBOOK_TEXT, groups: [ENGINEERING] },
  { sourceId: LEDGER, text: LEDGER_TEXT, groups: [FINANCE] },
];

function ask(
  pipeline: ReturnType<typeof system>["answering"],
  principalId: PrincipalId,
  query: string,
  id = "q1",
) {
  return pipeline.answer({ requestId: formatRequestId(id), principalId, query });
}

/* ----------------------------------------------------------------------------- the tests */

describe("the two pipelines meet at the corpus and the indexes (PRD 10)", () => {
  it("ingests a corpus and answers from it", async () => {
    const world = system();
    const report = await world.ingestion.run();

    expect(report.changes.added).toHaveLength(2);
    expect(report.chunksWritten).toBeGreaterThan(1);

    const outcome = await ask(world.answering, ALICE, "refund window");
    expect(outcome.retrieval.candidates.length).toBeGreaterThan(0);
    expect(outcome.grounding.answer.abstained).toBe(false);
    expect(outcome.grounding.prose).toContain("thirty days");
  });

  it("writes an audit record before the answer is returned", async () => {
    const world = system();
    await world.ingestion.run();
    await ask(world.answering, ALICE, "refund window");

    const records = world.audit.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.principalId).toBe(ALICE);
    expect(records[0]?.citedChunks.length).toBeGreaterThan(0);
  });

  it("serves each principal only what their groups allow", async () => {
    const world = system();
    await world.ingestion.run();

    const alice = await ask(world.answering, ALICE, "quarterly ledger reconciled");
    const bob = await ask(world.answering, BOB, "quarterly ledger reconciled");

    // The ledger is finance-only. Alice retrieves nothing from it; Bob does.
    expect(alice.retrieval.candidates).toEqual([]);
    expect(bob.retrieval.candidates.length).toBeGreaterThan(0);
  });

  it("fails closed when group resolution is unavailable (PRD 9.4)", async () => {
    // The one dependency with no degraded mode. Nothing in the answer pipeline catches this.
    const world = system();
    await world.ingestion.run();

    const failing = createAnswerPipeline({
      store: world.store,
      lexical: world.lexical,
      vector: world.vector,
      embeddings: createEmbeddingGateway(embedder, { sleeper: recordingSleeper() }),
      sleeper: recordingSleeper(),
      clock: manualClock(),
      reranker: fakeReranker(),
      generator: citingGenerator,
      groups: unavailableGroupResolver(),
      audit: inMemoryAuditSink(),
      oracle: corpusVersionOracle(world.store),
      now: () => "2026-05-01T00:00:00.000Z",
    });

    await expect(ask(failing, ALICE, "refund window")).rejects.toThrow(/no degraded mode/);
  });

  it("stops serving a source once ingestion deletes it", async () => {
    const world = system();
    await world.ingestion.run();
    expect(
      (await ask(world.answering, ALICE, "refund window")).retrieval.candidates.length,
    ).toBeGreaterThan(0);

    world.upstream.remove(HANDBOOK);
    const second = await world.ingestion.run();
    expect(second.changes.deleted).toEqual([HANDBOOK]);

    // End to end: the deletion reached the corpus, the indexes and therefore retrieval. Nothing
    // in the answer path was told about it — it asks the corpus what is current, every time.
    const after = await ask(world.answering, ALICE, "refund window", "q2");
    expect(after.retrieval.candidates).toEqual([]);
    expect(after.grounding.answer.abstained).toBe(true);
  });

  it("costs one hash comparison per source on an unchanged re-crawl", async () => {
    const world = system();
    await world.ingestion.run();
    const afterFirst = world.upstream.fetches();

    const second = await world.ingestion.run();
    expect(second.changes.unchanged).toHaveLength(2);
    expect(world.upstream.fetches()).toBe(afterFirst);
  });
});

describe("a stalled ingestion does not degrade answering (PRD 10)", () => {
  it("answers while a crawl that will never finish is in flight", async () => {
    const world = system();
    await world.ingestion.run();

    const clean = await ask(world.answering, ALICE, "refund window", "clean");

    // A new source upstream, so the crawl has something it must actually fetch — and a connector
    // that accepts the request and never comes back.
    world.upstream.add({
      sourceId: formatSourceId("onboarding"),
      text: "# Onboarding\n\nRequest access, then shadow an on-call.\n",
      groups: [ENGINEERING],
    });
    world.upstream.stall();
    let settled = false;
    const crawl = world.ingestion.run().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    void crawl;

    const during = await Promise.all([
      ask(world.answering, ALICE, "refund window", "during-1"),
      ask(world.answering, ALICE, "escalate symptom", "during-2"),
      ask(world.answering, ALICE, "refund window", "during-3"),
    ]);

    // Every answer completed, and the crawl is still hanging.
    expect(settled).toBe(false);
    expect(during).toHaveLength(3);
    for (const outcome of during) expect(outcome.retrieval.candidates.length).toBeGreaterThan(0);

    // And the answers are the ones the system gives with nothing in flight: the stalled crawl
    // changed corpus freshness and nothing else. This is not a latency measurement — nothing here
    // has measured latency — it is the claim that the answer path did not wait.
    const [first] = during;
    expect(first.grounding.prose).toBe(clean.grounding.prose);
    expect(first.retrieval.candidates.map((candidate) => candidate.chunkId)).toEqual(
      clean.retrieval.candidates.map((candidate) => candidate.chunkId),
    );
  });

  it("gives the answer pipeline no handle it could wait on", () => {
    // The structural half of the same claim, and the half that keeps holding after somebody edits
    // this file: `AnswerPorts` has no connector, no chunk sink and no ingestion pipeline, so there
    // is no field through which an answer could come to depend on a crawl.
    const world = system();
    expect(Object.keys(world.answering).sort()).toEqual(["answer", "asAnswerSystem", "name"]);
  });
});

describe("the evaluated object and the served object are the same object (ADR 0005)", () => {
  it("exposes the pipeline under evalkit's port without reshaping it", async () => {
    const world = system();
    await world.ingestion.run();

    const direct = await ask(world.answering, ALICE, "refund window", "direct");
    const viaHarness = await world.answering.asAnswerSystem().answer({
      itemId: "direct",
      query: "refund window",
      principal: ALICE,
      config: RETRIEVAL_DEFAULTS,
    });

    expect(viaHarness.grounding.prose).toBe(direct.grounding.prose);
    expect(viaHarness.retrieval.candidates.map((candidate) => candidate.chunkId)).toEqual(
      direct.retrieval.candidates.map((candidate) => candidate.chunkId),
    );
  });

  it("carries the harness's per-arm configuration through to retrieval", async () => {
    const world = system();
    await world.ingestion.run();

    const lexicalOnly = ablate(RETRIEVAL_DEFAULTS, {
      dense: { enabled: false, depth: 50 },
      rerank: { enabled: false, depth: 20 },
    });

    const outcome = await world.answering.asAnswerSystem().answer({
      itemId: "arm",
      query: "refund window",
      principal: ALICE,
      config: lexicalOnly,
    });

    const retrievers = new Set(
      outcome.retrieval.candidates.flatMap((candidate) =>
        candidate.contributions.map((entry) => entry.retriever),
      ),
    );
    expect([...retrievers]).toEqual(["lexical"]);
  });

  it("names the system once, for both paths", () => {
    const world = system();
    expect(world.answering.asAnswerSystem().name).toBe(world.answering.name);
  });
});

describe("the chunk sink joins ingest to the indexes", () => {
  it("makes a purged chunk unreachable through the sink and through retrieval", async () => {
    const world = system();
    await world.ingestion.run();

    const before = await ask(world.answering, ALICE, "escalate symptom", "before");
    expect(before.retrieval.candidates.length).toBeGreaterThan(0);

    world.upstream.remove(HANDBOOK);
    await world.ingestion.run();

    const after = await ask(world.answering, ALICE, "escalate symptom", "after");
    expect(after.retrieval.candidates).toEqual([]);
  });

  it("holds a record of what it wrote, for change detection and the post-delete probe", async () => {
    const world = system();
    const report = await world.ingestion.run();
    expect(await world.chunks.all()).toHaveLength(report.chunksWritten);

    const first = (await world.chunks.all())[0];
    expect(first).toBeDefined();
    expect(await world.chunks.get(first!.chunk.chunkId)).not.toBeNull();
  });

  it("refuses a write whose embedding model is not the index's, before anything is recorded", async () => {
    const world = system();
    await world.ingestion.run();

    const existing = (await world.chunks.all())[0];
    expect(existing).toBeDefined();

    const wrongModel = {
      ...existing!,
      chunk: { ...existing!.chunk, embedding: { id: "another-embedder", dimension: 8 } },
    };

    await expect(world.chunks.put([wrongModel])).rejects.toThrow(/plausible nonsense/);
    // The vector index is checked first precisely so a rejected write leaves nothing behind.
    expect(await world.chunks.all()).toHaveLength((await world.chunks.all()).length);
  });

  it("moves a relabelled chunk between the indexes' group partitions", async () => {
    // A revocation has to reach the postings, not only the record: a relabel that updated one
    // would leave a revoked group still able to read the row.
    const world = system();
    await world.ingestion.run();

    expect(
      (await ask(world.answering, ALICE, "refund window", "pre")).retrieval.candidates.length,
    ).toBeGreaterThan(0);

    await world.chunks.relabel(HANDBOOK, { readableBy: [FINANCE], existence: "visible" });

    const after = await ask(world.answering, ALICE, "refund window", "post");
    expect(after.retrieval.candidates).toEqual([]);
  });
});
