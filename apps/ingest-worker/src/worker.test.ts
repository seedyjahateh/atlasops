/**
 * Ingestion worker tests.
 *
 * The worker is configuration, assembly and a report. The crawl itself is `ingest`'s and is tested
 * there; what is tested here is that a misconfiguration refuses to start, and that a run somebody
 * scheduled tells them what happened — including the two things a quiet report would hide: a
 * partial view of the upstream, and an isolated source failure.
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ConfigError, createWorker, describeRun, readWorkerConfig } from "./worker.js";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus", import.meta.url));

describe("configuration", () => {
  it("refuses to start without a corpus", () => {
    // Starting anyway would make a misconfiguration look like an empty upstream — and an empty
    // upstream, read as truth, deletes everything.
    expect(() => readWorkerConfig({})).toThrow(/has nothing to do/);
  });

  it("refuses a storage profile that is not built", () => {
    expect(() =>
      readWorkerConfig({ ATLASOPS_CORPUS_ROOT: CORPUS, ATLASOPS_STORE: "opensearch" }),
    ).toThrow(/not implemented in this build/);
  });

  it("refuses a chunk budget too small to be meaningful", () => {
    expect(() =>
      readWorkerConfig({ ATLASOPS_CORPUS_ROOT: CORPUS, ATLASOPS_CHUNK_TOKENS: "4" }),
    ).toThrow(ConfigError);
  });

  it("takes the chunk budget as a per-connector decision", () => {
    const config = readWorkerConfig({
      ATLASOPS_CORPUS_ROOT: CORPUS,
      ATLASOPS_CHUNK_TOKENS: "128",
    });
    expect(config.maxTokens).toBe(128);
  });
});

describe("a run", () => {
  it("crawls the corpus and writes chunks", async () => {
    const worker = createWorker(readWorkerConfig({ ATLASOPS_CORPUS_ROOT: CORPUS }));
    const report = await worker.run();

    expect(report.changes.added.length).toBeGreaterThan(0);
    expect(report.chunksWritten).toBeGreaterThan(0);
    expect(report.failures).toEqual([]);
  });

  it("costs no fetch on an unchanged second crawl", async () => {
    const worker = createWorker(readWorkerConfig({ ATLASOPS_CORPUS_ROOT: CORPUS }));
    await worker.run();
    const second = await worker.run();

    expect(second.fetched).toBe(0);
    expect(second.modelCalls).toBe(0);
    expect(second.changes.unchanged.length).toBeGreaterThan(0);
  });

  it("reports the numbers a scheduler needs", async () => {
    const worker = createWorker(readWorkerConfig({ ATLASOPS_CORPUS_ROOT: CORPUS }));
    const described = describeRun(await worker.run()).join("\n");

    expect(described).toContain("chunks written");
    expect(described).toContain("model calls");
    expect(described).toContain("deleted");
  });

  it("says loudly when deletions were withheld", () => {
    const described = describeRun({
      connector: "filesystem",
      observedAt: "2026-05-01T00:00:00.000Z",
      changes: {
        added: [],
        modified: [],
        unchanged: [],
        deleted: [],
        tombstoned: [],
        deletionsWithheld: true,
      },
      outcomes: [],
      fetched: 0,
      parsed: 0,
      modelCalls: 0,
      chunksWritten: 0,
      chunksPurged: 0,
      cacheEvictions: 0,
      embeddingTokens: 0,
      failures: [],
      deletionsWithheld: true,
    }).join("\n");

    // A crawl that half-failed looks exactly like a corpus that shrank, which is why this is not
    // a debug-level detail.
    expect(described).toContain("deletions were withheld");
  });

  it("names every source that failed", () => {
    const described = describeRun({
      connector: "filesystem",
      observedAt: "2026-05-01T00:00:00.000Z",
      changes: {
        added: [],
        modified: [],
        unchanged: [],
        deleted: [],
        tombstoned: [],
        deletionsWithheld: false,
      },
      outcomes: [],
      fetched: 1,
      parsed: 0,
      modelCalls: 0,
      chunksWritten: 0,
      chunksPurged: 0,
      cacheEvictions: 0,
      embeddingTokens: 0,
      failures: [
        {
          sourceId: "src_broken.md" as never,
          disposition: "failed",
          chunks: 0,
          embedded: 0,
          reused: 0,
          purged: 0,
          error: "could not read",
        },
      ],
      deletionsWithheld: false,
    }).join("\n");

    expect(described).toContain("1 source(s) failed");
    expect(described).toContain("src_broken.md");
  });
});
