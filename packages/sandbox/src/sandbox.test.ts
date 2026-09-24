/**
 * Sandbox tests (P17a).
 *
 * Two things matter about a package whose job is to construct the platform for other people.
 *
 * The first is that what it constructs is the platform — the same pre-filter, the same pipelines,
 * the same snapshot — and not a lookalike. An exhibit built on a sandbox that quietly skipped the
 * permission filter would demonstrate something the platform does not do.
 *
 * The second is that it can never be mistaken for a deployment. Every model it records is a
 * stand-in whose identifier says so, and a test holds that, because the first time somebody wires a
 * real model into a convenience package is the day its numbers start being quoted.
 */

import {
  formatGroupId,
  formatPrincipalId,
  formatRequestId,
  formatSourceId,
} from "@atlasops/contracts";
import { corpusSnapshotOf } from "@atlasops/composition";
import { staticGroupResolver } from "@atlasops/governance";
import { fixtureConnector, structureAware } from "@atlasops/ingest";
import { describe, expect, it } from "vitest";

import { STAND_IN_MODELS, createSandbox } from "./sandbox.js";

const ENGINEERING = formatGroupId("engineering");
const FINANCE = formatGroupId("finance");

const HANDBOOK = formatSourceId("handbook");
const LEDGER = formatSourceId("ledger");

function sandbox(options: { retrievalCache?: boolean } = {}) {
  return createSandbox({
    connector: fixtureConnector({
      strategy: structureAware({ maxTokens: 128, boundaryDepth: 2 }),
      observedAt: "2026-09-24T00:00:00.000Z",
      acl: { readableBy: [ENGINEERING], existence: "visible" },
      sources: [
        {
          sourceId: HANDBOOK,
          text: "# Handbook\n\n## Refunds\n\nThe refund window is thirty days from delivery.\n",
        },
        {
          sourceId: LEDGER,
          text: "# Ledger\n\n## Close\n\nThe ledger cuts off at five on the last working day.\n",
          acl: { readableBy: [FINANCE], existence: "visible" },
        },
      ],
    }),
    groups: staticGroupResolver({ prn_alice: [ENGINEERING], prn_frank: [FINANCE] }),
    ...(options.retrievalCache === undefined ? {} : { retrievalCache: options.retrievalCache }),
  });
}

async function ask(
  system: ReturnType<typeof sandbox>,
  principal: string,
  query: string,
  id: string,
) {
  return system.answering.answer({
    requestId: formatRequestId(id),
    principalId: formatPrincipalId(principal.replace(/^prn_/, "")),
    query,
  });
}

describe("it constructs the platform, not a lookalike", () => {
  it("ingests through the connector it was given and answers from it", async () => {
    const system = sandbox();
    const report = await system.ingestion.run();

    expect(report.failures).toEqual([]);
    const outcome = await ask(system, "prn_alice", "refund window", "q1");
    expect(outcome.retrieval.candidates.length).toBeGreaterThan(0);
  });

  it("applies the permission pre-filter", async () => {
    // A sandbox that skipped the filter would let an exhibit demonstrate something the platform
    // does not do. prn_alice is engineering; the ledger is finance.
    const system = sandbox();
    await system.ingestion.run();

    const outcome = await ask(system, "prn_alice", "ledger cuts off last working day", "q1");
    for (const candidate of outcome.retrieval.candidates) {
      expect(candidate.sourceId).not.toBe(LEDGER);
    }
  });

  it("computes the snapshot the way the evaluation runner does", async () => {
    // Two implementations of "which corpus is this" agree until they do not (P14a).
    const system = sandbox();
    await system.ingestion.run();

    expect(system.snapshot()).toBe(corpusSnapshotOf(system.store));
  });

  it("keeps the chunks' offsets reachable without widening the index", async () => {
    // `indexing` has no unfiltered accessor, deliberately. The sink's own record is how an exhibit
    // that needs a chunk's position — a line-level citation — gets it.
    const system = sandbox();
    await system.ingestion.run();

    const all = await system.chunks.all();
    expect(all.length).toBeGreaterThan(0);
    const first = all[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(await system.chunks.get(first.chunk.chunkId)).not.toBeNull();
  });

  it("serves a repeated query from the retrieval cache by default, as a deployment would", async () => {
    const system = sandbox();
    await system.ingestion.run();

    await ask(system, "prn_alice", "refund window", "q1");
    const again = await ask(system, "prn_alice", "refund window", "q2");
    expect(again.retrieval.cacheHit).toBe(true);
  });

  it("can turn the cache off, for a caller measuring the answer path", async () => {
    // What the P15 load run showed: with the cache on and a repeating workload, the latency
    // figure describes a cache lookup. A caller measuring answers has to be able to say so.
    const system = sandbox({ retrievalCache: false });
    await system.ingestion.run();

    await ask(system, "prn_alice", "refund window", "q1");
    const again = await ask(system, "prn_alice", "refund window", "q2");
    expect(again.retrieval.cacheHit).toBe(false);
  });
});

describe("it can never be mistaken for a deployment", () => {
  it("names every model it uses as a stand-in", () => {
    for (const [role, id] of Object.entries(STAND_IN_MODELS)) {
      expect(id, role).toMatch(/^stand-in/);
    }
  });

  it("records only stand-in models in the audit of an answer it produced", async () => {
    // The identifiers reach every artefact built on this package. If one of them ever stopped
    // saying "stand-in", a number measured here could be quoted as a model's.
    const system = sandbox();
    await system.ingestion.run();
    await ask(system, "prn_alice", "refund window", "q1");

    const records = system.audit.records();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      for (const model of record.models) expect(model).toMatch(/^stand-in/);
    }
  });

  it("indexes with the stand-in embedding, whose identifier says what it is", async () => {
    const system = sandbox();
    await system.ingestion.run();

    for (const stored of await system.chunks.all()) {
      expect(stored.chunk.embedding.id).toBe(STAND_IN_MODELS.embedder);
    }
  });
});
