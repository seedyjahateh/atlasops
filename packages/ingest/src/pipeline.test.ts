/**
 * Ingestion pipeline tests (P6b).
 *
 * Every one of PRD 4.5's five rows is measured here against the named fixture corpus, through the
 * method the PRD states, and asserted with `assertWithinIngestionBudget` — which cannot be called
 * without a `ReferenceProfile`. The numbers that come out are measurements of this fixture on this
 * machine and are not results for anything else.
 *
 * Nothing calls a paid API. The embedder is `model-gateway`'s deterministic fake, the connector is
 * the in-repo fixture connector, and the sink is in memory.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  contentHashOf,
  parseGroupId,
  parsePrincipalId,
  parseSourceId,
  type ChunkId,
  type SourceId,
} from "@atlasops/contracts";
import { inMemoryCorpusStore, type ConnectorListing, type CorpusStore } from "@atlasops/corpus";
import type { Principal } from "@atlasops/governance";
import {
  countingEmbedder,
  createEmbeddingGateway,
  embeddingCacheKey,
  fakeEmbedder,
  inMemoryEmbeddingCache,
  recordingSleeper,
  type EmbeddingGateway,
  type RecordingEmbeddingCache,
} from "@atlasops/model-gateway";
import { UNPRICED_TABLE, measure } from "@atlasops/telemetry";
import { describe, expect, it } from "vitest";

import {
  assertWithinIngestionBudget,
  ingestionBudgetById,
  ingestionCostPer1kChunks,
  ingestionProfile,
} from "./budgets.js";
import type { Connector, FetchedSource } from "./connector.js";
import { fixtureConnector, type FixtureConnector } from "./fixture-connector.js";
import { ingest, probeRemoved, type IngestionReport } from "./pipeline.js";
import { failingChunkSink, inMemoryChunkSink, type ChunkSink } from "./sink.js";
import { structureAware } from "./strategy.js";

/* --------------------------------------------------------------------------- the fixture */

interface CorpusFixture {
  readonly id: string;
  readonly hardware: string;
  readonly acl: unknown;
  readonly chunking: { readonly maxTokens: number; readonly boundaryDepth: number };
  readonly sources: readonly { readonly sourceId: string; readonly file: string }[];
  readonly revision: {
    readonly sourceId: string;
    readonly find: string;
    readonly replace: string;
  };
}

const FIXTURE_DIR = new URL("../fixtures/", import.meta.url);

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("corpus.json", FIXTURE_DIR)), "utf8"),
) as CorpusFixture;

const SOURCES = FIXTURE.sources.map((entry) => ({
  sourceId: parseSourceId(entry.sourceId, "fixture.sourceId"),
  text: readFileSync(fileURLToPath(new URL(entry.file, FIXTURE_DIR)), "utf8"),
}));

const HANDBOOK = parseSourceId(FIXTURE.revision.sourceId, "fixture.revision.sourceId");
const POLICY = parseSourceId("src_retention_policy", "fixture");

const MARCH = "2026-03-01T00:00:00.000Z";
const APRIL = "2026-04-01T00:00:00.000Z";

const ADMIN: Principal = {
  id: parsePrincipalId("prn_ingest_worker", "fixture"),
  groups: [parseGroupId("grp_platform", "fixture")],
};

const PROFILE = ingestionProfile({
  id: FIXTURE.id,
  corpusSnapshot: contentHashOf(SOURCES.map((source) => source.text).join("\u001f")),
  connector: "fixture",
  embeddingModelId: "fake-embedder",
  hardware: FIXTURE.hardware,
});

function measured(budgetId: string, value: number, unit: string, samples: number) {
  return measure({
    budgetId,
    value,
    unit,
    profile: PROFILE,
    sampleSize: samples,
    measuredAt: APRIL,
  });
}

/* --------------------------------------------------------------------------- the harness */

interface Harness {
  readonly connector: FixtureConnector;
  readonly store: CorpusStore;
  readonly sink: ChunkSink;
  readonly cache: RecordingEmbeddingCache;
  readonly gateway: EmbeddingGateway;
  readonly calls: () => number;
  readonly run: () => Promise<IngestionReport>;
}

function harness(options?: { readonly sink?: ChunkSink; readonly complete?: boolean }): Harness {
  const cache = inMemoryEmbeddingCache();
  const embedder = countingEmbedder(fakeEmbedder());
  const gateway = createEmbeddingGateway(embedder, { sleeper: recordingSleeper(), cache });
  const store = inMemoryCorpusStore();
  const sink = options?.sink ?? inMemoryChunkSink();

  const connector = fixtureConnector({
    strategy: structureAware(FIXTURE.chunking),
    sources: SOURCES,
    observedAt: MARCH,
    acl: FIXTURE.acl,
    ...(options?.complete === undefined ? {} : { complete: options.complete }),
  });

  return {
    connector,
    store,
    sink,
    cache,
    gateway,
    calls: embedder.calls,
    run: (): Promise<IngestionReport> =>
      ingest({ connector, store, gateway, sink, orderedBy: ADMIN, cache }),
  };
}

const edited = (text: string): string =>
  text.replace(FIXTURE.revision.find, FIXTURE.revision.replace);

async function chunkIdsFor(sink: ChunkSink, sourceId: SourceId): Promise<readonly ChunkId[]> {
  const all = await sink.all();
  return all
    .filter((entry) => entry.chunk.sourceId === sourceId)
    .map((entry) => entry.chunk.chunkId);
}

/* ----------------------------------------------------------------------------- the tests */

describe("a first crawl", () => {
  it("adds every source and writes its chunks", async () => {
    const world = harness();
    const report = await world.run();

    expect(report.changes.added).toHaveLength(SOURCES.length);
    expect(report.fetched).toBe(SOURCES.length);
    expect(report.parsed).toBe(SOURCES.length);
    expect(report.chunksWritten).toBeGreaterThan(SOURCES.length);
    expect(await world.sink.all()).toHaveLength(report.chunksWritten);
  });

  it("makes each source's head live in the corpus", async () => {
    const world = harness();
    await world.run();
    for (const source of SOURCES) {
      expect(world.store.liveVersion(source.sourceId)).not.toBeNull();
    }
  });

  it("carries the connector's access label onto every stored chunk", async () => {
    const world = harness();
    await world.run();
    for (const entry of await world.sink.all()) {
      expect(entry.chunk.acl.readableBy).toEqual([parseGroupId("grp_engineering", "fixture")]);
    }
  });

  it("verifies that the revision fixture actually edits the document", () => {
    // A find string that stopped matching would make the reuse measurement below trivially 100%.
    const source = SOURCES.find((entry) => entry.sourceId === HANDBOOK);
    expect(source).toBeDefined();
    expect(edited(source!.text)).not.toBe(source!.text);
  });
});

describe("PRD 4.5: an unchanged source costs one hash comparison", () => {
  it("fetches nothing, parses nothing and calls no model on a second crawl", async () => {
    const world = harness();
    await world.run();
    world.connector.resetCounters();

    const second = await world.run();

    expect(second.changes.unchanged).toHaveLength(SOURCES.length);
    expect(world.connector.fetches()).toBe(0);
    expect(second.fetched).toBe(0);
    expect(second.parsed).toBe(0);
    expect(second.chunksWritten).toBe(0);

    assertWithinIngestionBudget(
      ingestionBudgetById("UNCHANGED-REINGESTION-CALLS"),
      measured("UNCHANGED-REINGESTION-CALLS", second.modelCalls, "calls", SOURCES.length),
      second.outcomes.map((outcome) => `${outcome.sourceId}: ${outcome.disposition}`),
    );
  });

  it("leaves the index exactly as it was", async () => {
    const world = harness();
    const first = await world.run();
    const before = await world.sink.all();

    await world.run();

    expect(await world.sink.all()).toEqual(before);
    expect(first.chunksPurged).toBe(0);
  });
});

describe("PRD 4.5: chunk reuse on a single-paragraph edit", () => {
  it("re-embeds only the passages that changed", async () => {
    const world = harness();
    await world.run();

    const source = SOURCES.find((entry) => entry.sourceId === HANDBOOK);
    world.connector.revise(HANDBOOK, edited(source!.text));
    world.connector.observedAt(APRIL);

    const second = await world.run();
    const outcome = second.outcomes.find((entry) => entry.sourceId === HANDBOOK);

    expect(second.changes.modified).toEqual([HANDBOOK]);
    expect(outcome).toBeDefined();
    expect(outcome!.chunks).toBeGreaterThan(10);

    const ratio = outcome!.reused / outcome!.chunks;
    assertWithinIngestionBudget(
      ingestionBudgetById("CHUNK-REUSE-ON-EDIT"),
      measured("CHUNK-REUSE-ON-EDIT", ratio, "ratio", outcome!.chunks),
      [
        `${String(outcome!.reused)} of ${String(outcome!.chunks)} chunk texts served from cache`,
        `${String(outcome!.embedded)} sent to the model`,
      ],
    );
  });

  it("does not re-embed the sources that were not touched", async () => {
    const world = harness();
    await world.run();
    const afterFirst = world.calls();

    const source = SOURCES.find((entry) => entry.sourceId === HANDBOOK);
    world.connector.revise(HANDBOOK, edited(source!.text));
    world.connector.observedAt(APRIL);
    await world.run();

    // One further embedding call, for the one source that changed.
    expect(world.calls()).toBe(afterFirst + 1);
  });

  it("purges the superseded version from the index but keeps its vectors cached", async () => {
    const world = harness();
    await world.run();
    const cachedAfterFirst = world.cache.size();
    const firstHead = world.store.state(HANDBOOK)?.head;

    const source = SOURCES.find((entry) => entry.sourceId === HANDBOOK);
    world.connector.revise(HANDBOOK, edited(source!.text));
    world.connector.observedAt(APRIL);
    const second = await world.run();

    // The old version left the index: retention keeps only the head live (PRD 4.1).
    const remaining = await world.sink.all();
    expect(remaining.some((entry) => entry.chunk.sourceVersionId === firstHead)).toBe(false);
    expect(second.chunksPurged).toBeGreaterThan(0);

    // Its vectors did not leave the cache — that is the reuse mechanism, and evicting them here
    // would make every revision cost a full re-embedding.
    expect(world.cache.size()).toBeGreaterThan(cachedAfterFirst);
    expect(second.cacheEvictions).toBe(0);
  });
});

describe("PRD 4.5: re-ingestion is deterministic", () => {
  it("produces a byte-identical chunk set from two independent runs", async () => {
    const a = harness();
    const b = harness();
    await a.run();
    await b.run();

    const identity = async (sink: ChunkSink): Promise<readonly string[]> =>
      (await sink.all())
        .map((entry) => `${entry.chunk.chunkId}\u001f${entry.chunk.contentHash}`)
        .sort();

    const left = await identity(a.sink);
    const right = await identity(b.sink);
    const diffs = left.filter((entry, index) => right[index] !== entry).length;

    assertWithinIngestionBudget(
      ingestionBudgetById("REINGESTION-DIFFS"),
      measured("REINGESTION-DIFFS", diffs, "chunks", left.length),
      [`${String(left.length)} chunks compared by identifier and content hash`],
    );
    expect(left).toEqual(right);
  });
});

describe("PRD 4.5: deletion propagates before the job returns", () => {
  it("removes the chunks from the index and the vectors from the cache", async () => {
    const world = harness();
    await world.run();

    const doomed = await chunkIdsFor(world.sink, POLICY);
    const texts = (await world.sink.all())
      .filter((entry) => entry.chunk.sourceId === POLICY)
      .map((entry) => entry.text);
    const keys = texts.map((text) => embeddingCacheKey(world.gateway.model, text));

    expect(doomed.length).toBeGreaterThan(0);
    expect(keys.every((key) => world.cache.get(key) !== undefined)).toBe(true);

    world.connector.remove(POLICY);
    world.connector.observedAt(APRIL);
    const second = await world.run();

    expect(second.changes.deleted).toEqual([POLICY]);
    expect(second.cacheEvictions).toBe(doomed.length);

    const probe = await probeRemoved({
      sink: world.sink,
      chunkIds: doomed,
      cache: world.cache,
      cacheKeys: keys,
    });

    assertWithinIngestionBudget(
      ingestionBudgetById("DELETION-RESIDUE"),
      measured(
        "DELETION-RESIDUE",
        probe.inIndex.length + probe.inCache.length,
        "chunks",
        doomed.length,
      ),
      [
        `${String(probe.inIndex.length)} of ${String(doomed.length)} chunks still in the index`,
        `${String(probe.inCache.length)} of ${String(keys.length)} vectors still cached`,
      ],
    );
  });

  it("records a tombstone attributed to the principal that ordered it", async () => {
    const world = harness();
    await world.run();
    world.connector.remove(POLICY);
    world.connector.observedAt(APRIL);
    await world.run();

    const tombstone = world.store.state(POLICY)?.tombstone;
    expect(tombstone?.orderedBy).toBe(ADMIN.id);
    expect(tombstone?.reason).toContain("absent from a complete listing");
  });

  it("leaves every other source alone", async () => {
    const world = harness();
    await world.run();
    const survivors = await chunkIdsFor(world.sink, HANDBOOK);

    world.connector.remove(POLICY);
    world.connector.observedAt(APRIL);
    await world.run();

    expect(await chunkIdsFor(world.sink, HANDBOOK)).toEqual(survivors);
  });

  it("does not delete anything when the listing is not complete", async () => {
    // An expired token returning a short page must not be read as "everything else was deleted".
    const world = harness({ complete: false });
    await world.run();
    world.connector.remove(POLICY);
    world.connector.observedAt(APRIL);

    const second = await world.run();

    expect(second.deletionsWithheld).toBe(true);
    expect(second.changes.deleted).toEqual([]);
    expect(second.chunksPurged).toBe(0);
    expect(await chunkIdsFor(world.sink, POLICY)).not.toEqual([]);
  });

  it("reports what survived rather than a bare boolean", async () => {
    const world = harness();
    await world.run();
    const live = await chunkIdsFor(world.sink, HANDBOOK);

    const probe = await probeRemoved({ sink: world.sink, chunkIds: live });
    expect(probe.inIndex).toEqual(live);
  });
});

describe("PRD 4.5: one bad source fails alone", () => {
  it("ingests the rest of the batch and reports the failure", async () => {
    const world = harness();
    world.connector.breakSource(HANDBOOK, "403 from the wiki");

    const report = await world.run();

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.sourceId).toBe(HANDBOOK);
    expect(report.failures[0]?.error).toContain("403");

    const succeeded = report.outcomes.filter((outcome) => outcome.disposition === "added");
    expect(succeeded).toHaveLength(SOURCES.length - 1);

    assertWithinIngestionBudget(
      ingestionBudgetById("FAILURE-COLLATERAL"),
      measured("FAILURE-COLLATERAL", report.failures.length - 1, "sources", SOURCES.length),
      report.outcomes.map((outcome) => `${outcome.sourceId}: ${outcome.disposition}`),
    );
  });

  it("leaves the corpus with no record of the source that failed", async () => {
    const world = harness();
    world.connector.breakSource(HANDBOOK);
    await world.run();

    expect(world.store.state(HANDBOOK)).toBeNull();
    expect(world.store.state(POLICY)).not.toBeNull();
  });

  it("retries the failed source on the next crawl", async () => {
    const world = harness();
    world.connector.breakSource(HANDBOOK);
    await world.run();

    const recovered = fixtureConnector({
      strategy: structureAware(FIXTURE.chunking),
      sources: SOURCES,
      observedAt: APRIL,
      acl: FIXTURE.acl,
    });
    const second = await ingest({
      connector: recovered,
      store: world.store,
      gateway: world.gateway,
      sink: world.sink,
      orderedBy: ADMIN,
      cache: world.cache,
    });

    expect(second.changes.added).toEqual([HANDBOOK]);
    expect(world.store.liveVersion(HANDBOOK)).not.toBeNull();
  });
});

describe("the index is written before the corpus advances", () => {
  it("does not advance the corpus when the index write fails", async () => {
    // The failure this ordering prevents: the corpus claims a live version retrieval cannot see,
    // and the next crawl finds the source unchanged and never retries it.
    const world = harness({ sink: failingChunkSink() });
    const report = await world.run();

    expect(report.failures).toHaveLength(SOURCES.length);
    for (const source of SOURCES) expect(world.store.state(source.sourceId)).toBeNull();
  });

  it("succeeds on the next crawl once the index is back", async () => {
    const store = inMemoryCorpusStore();
    const cache = inMemoryEmbeddingCache();
    const gateway = createEmbeddingGateway(fakeEmbedder(), {
      sleeper: recordingSleeper(),
      cache,
    });
    const connector = fixtureConnector({
      strategy: structureAware(FIXTURE.chunking),
      sources: SOURCES,
      observedAt: MARCH,
      acl: FIXTURE.acl,
    });

    const broken = await ingest({
      connector,
      store,
      gateway,
      sink: failingChunkSink(),
      orderedBy: ADMIN,
      cache,
    });
    expect(broken.failures).toHaveLength(SOURCES.length);

    const healthy = await ingest({
      connector,
      store,
      gateway,
      sink: inMemoryChunkSink(),
      orderedBy: ADMIN,
      cache,
    });
    expect(healthy.changes.added).toHaveLength(SOURCES.length);
    expect(healthy.failures).toEqual([]);
  });
});

describe("a source that reverts between the listing and the fetch", () => {
  it("relabels in place rather than re-embedding", async () => {
    // A real race, and the one path on which the corpus reports `acl-changed` to this pipeline.
    const world = harness();
    await world.run();

    const head = world.store.state(POLICY)?.head;
    const source = SOURCES.find((entry) => entry.sourceId === POLICY);
    const support = parseGroupId("grp_support", "fixture");

    // A connector whose listing is stale by one revision: it reports a hash that is not the
    // head's, and then hands back the head's bytes with a new label.
    const racing: Connector = {
      name: "racing",
      strategy: structureAware(FIXTURE.chunking),
      list: (): Promise<ConnectorListing> =>
        Promise.resolve({
          connector: "racing",
          observedAt: APRIL,
          complete: false,
          sources: [{ sourceId: POLICY, contentHash: contentHashOf("a revision that was undone") }],
        }),
      fetch: (): Promise<FetchedSource> =>
        Promise.resolve({
          text: source!.text,
          observation: {
            sourceId: POLICY,
            contentHash: contentHashOf(source!.text),
            observedAt: APRIL,
            effectiveDate: null,
            upstreamRevision: null,
            acl: { readableBy: ["grp_support"], existence: "visible" },
          },
        }),
    };

    const report = await ingest({
      connector: racing,
      store: world.store,
      gateway: world.gateway,
      sink: world.sink,
      orderedBy: ADMIN,
      cache: world.cache,
    });

    const outcome = report.outcomes.find((entry) => entry.sourceId === POLICY);
    expect(outcome?.disposition).toBe("relabelled");
    expect(outcome?.embedded).toBe(0);
    expect(world.store.state(POLICY)?.head).toBe(head);

    for (const entry of await world.sink.all()) {
      if (entry.chunk.sourceId !== POLICY) continue;
      expect(entry.chunk.acl.readableBy).toEqual([support]);
    }
  });
});

describe("the cost budget is unmeasurable, not met (ADR 0002)", () => {
  it("refuses to price an ingestion run against the empty table", async () => {
    const world = harness();
    const report = await world.run();

    expect(report.embeddingTokens).toBeGreaterThan(0);
    expect(() => ingestionCostPer1kChunks(report, UNPRICED_TABLE, "fake-embedder")).toThrow(
      /price/i,
    );
  });

  it("refuses to divide by a run that wrote no chunks", async () => {
    const world = harness();
    await world.run();
    const second = await world.run();

    expect(second.chunksWritten).toBe(0);
    expect(() => ingestionCostPer1kChunks(second, UNPRICED_TABLE, "fake-embedder")).toThrow(
      /undefined/,
    );
  });
});

describe("the budget checker itself", () => {
  it("treats a floor as a floor, not a ceiling", () => {
    const budget = ingestionBudgetById("CHUNK-REUSE-ON-EDIT");
    expect(budget.direction).toBe("at-least");
    expect(() =>
      assertWithinIngestionBudget(budget, measured("CHUNK-REUSE-ON-EDIT", 0.1, "ratio", 20), [
        "a corpus that reused almost nothing",
      ]),
    ).toThrow(/BUDGET_EXCEEDED|floor/);
  });

  it("refuses a measurement in the wrong unit", () => {
    expect(() =>
      assertWithinIngestionBudget(
        ingestionBudgetById("DELETION-RESIDUE"),
        measured("DELETION-RESIDUE", 0, "sources", 1),
        [],
      ),
    ).toThrow(/measured in chunks/);
  });

  it("names the measurement method in the failure, so the response is not a rerun", () => {
    try {
      assertWithinIngestionBudget(
        ingestionBudgetById("DELETION-RESIDUE"),
        measured("DELETION-RESIDUE", 3, "chunks", 20),
        ["chk_a", "chk_b", "chk_c"],
      );
      expect.unreachable("an exceeded budget must throw");
    } catch (error) {
      expect((error as Error).message).toContain("post-delete probe");
      expect((error as Error).message).toContain("chk_b");
      expect((error as Error).message).toContain("not moved to make this pass");
    }
  });

  it("records the profile with every measurement, so a number is quotable", () => {
    const result = assertWithinIngestionBudget(
      ingestionBudgetById("REINGESTION-DIFFS"),
      measured("REINGESTION-DIFFS", 0, "chunks", 20),
      [],
    );
    expect(result.measurement.profile.id).toBe(FIXTURE.id);
    expect(result.measurement.profile.models.embedder).toBe("fake-embedder");
    expect(result.summary).toContain("synthetic");
  });
});
