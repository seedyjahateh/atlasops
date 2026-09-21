/**
 * Evalkit tests (P10a).
 *
 * The metrics are tested against hand-built outcomes with known answers, because a metric checked
 * only against "a plausible-looking number came out" is exactly the kind of thing that ships wrong
 * and is believed for a year. Where a value is arithmetic, the expected number is worked out in the
 * test rather than snapshotted from the implementation.
 *
 * Two behaviours get more than one test each, because they are the ones the PRD makes load-bearing:
 * nDCG is graded rather than binary (8.1, 8.2), and leak count is a hard gate rather than a score
 * (8.4).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseAnswer, type Answer } from "@atlasops/contracts";
import { abstentionMessage } from "@atlasops/governance";
import type { FusedCandidate } from "@atlasops/retrieval";
import { describe, expect, it } from "vitest";

import {
  correctAbstentionRate,
  overAbstentionRate,
  type AbstentionOutcome,
} from "./abstention-metrics.js";
import {
  citationPrecision,
  citationRecall,
  spanValidityRate,
  type AnswerOutcome,
} from "./citation-metrics.js";
import { datasetContentHash, loadDataset, seal, type DatasetInput } from "./dataset.js";
import {
  assertNoLeaks,
  existenceDisclosureCount,
  leakCount,
  type ProbeOutcome,
} from "./governance-metrics.js";
import { metricResult, pairScores } from "./metric.js";
import {
  meanReciprocalRank,
  ndcgAt,
  perRetrieverContribution,
  recallAt,
  type FusedOutcome,
  type RankedOutcome,
} from "./retrieval-metrics.js";
import type {
  AbstentionItem,
  GroundedAnswerItem,
  PermissionProbeItem,
  RelevanceItem,
} from "./shapes.js";

/* -------------------------------------------------------------------------------- fixtures */

const RAW = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/datasets.v1.json", import.meta.url)), "utf8"),
) as Record<string, DatasetInput<never>>;

const A = "chk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0";
const B = "chk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_0";
const C = "chk_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc_0";
const D = "chk_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd_0";

const VERSION_A = "sv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VERSION_B = "sv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const relevance = loadDataset(RAW.relevance as unknown as DatasetInput<RelevanceItem>);
const grounded = loadDataset(RAW.groundedAnswers as unknown as DatasetInput<GroundedAnswerItem>);
const abstention = loadDataset(RAW.abstention as unknown as DatasetInput<AbstentionItem>);
const probes = loadDataset(RAW.permissionProbe as unknown as DatasetInput<PermissionProbeItem>);

/** The same artefact with no declared hash, for the cases that are about something else. */
function unhashed<Item extends { id: string; split: "development" | "held-out" }>(
  input: DatasetInput<Item>,
  items: readonly Item[],
  corpusSnapshot: string = input.corpusSnapshot,
): DatasetInput<Item> {
  return { id: input.id, version: input.version, kind: input.kind, corpusSnapshot, items };
}

function answer(references: readonly { chunkId: string; sourceVersionId: string }[]): Answer {
  return parseAnswer({
    requestId: "req_r1",
    abstained: false,
    segments: [
      {
        text: "a claim",
        references: references.map((reference) => ({ ...reference, span: { start: 0, end: 5 } })),
      },
    ],
  });
}

const ABSTAINED: Answer = {
  requestId: "req_r1" as Answer["requestId"],
  abstained: true,
  reason: "low-support",
};

function fused(chunkId: string, rank: number, retrievers: readonly string[]): FusedCandidate {
  return {
    chunkId: chunkId as FusedCandidate["chunkId"],
    sourceId: "src_s" as FusedCandidate["sourceId"],
    sourceVersionId: VERSION_A as FusedCandidate["sourceVersionId"],
    headingPath: [],
    text: "passage",
    acl: { readableBy: [], existence: "visible" },
    score: 1,
    rank,
    fusedScore: 1 / (60 + rank),
    contributions: retrievers.map((retriever) => ({ retriever, rank })),
    rerankScore: null,
  };
}

/* -------------------------------------------------------------------------------- datasets */

describe("datasets are versioned artefacts (PRD 8.1)", () => {
  it("loads each of the four shapes with its declared hash intact", () => {
    for (const dataset of [relevance, grounded, abstention, probes]) {
      expect(dataset.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(dataset.version).toBe("1.0.0");
    }
  });

  it("refuses a file whose labels moved without its version moving", () => {
    // The first of PRD 8.1's two ways to fake an improvement: quietly re-label the hard queries.
    const tampered = {
      ...(RAW.relevance as unknown as DatasetInput<RelevanceItem>),
      items: relevance.items.map((item) =>
        item.id === "rel-001" ? { ...item, judgments: { [A]: 3, [B]: 3 } } : item,
      ),
    };
    expect(() => loadDataset(tampered)).toThrow(/labels changed without the version moving/);
  });

  it("derives the same hash regardless of key order in the source file", () => {
    const reordered = relevance.items.map((item) => ({
      judgments: item.judgments,
      principal: item.principal,
      query: item.query,
      split: item.split,
      id: item.id,
      subpopulation: item.subpopulation,
    }));
    expect(datasetContentHash(reordered)).toBe(relevance.contentHash);
  });

  it("refuses a duplicated item", () => {
    const source = RAW.abstention as unknown as DatasetInput<AbstentionItem>;
    const doubled = unhashed(source, [...abstention.items, abstention.items[0]!]);
    expect(() => loadDataset(doubled)).toThrow(/appears twice/);
  });

  it("refuses an empty dataset", () => {
    const source = RAW.abstention as unknown as DatasetInput<AbstentionItem>;
    expect(() => loadDataset(unhashed(source, []))).toThrow(/absence of one/);
  });

  it("refuses a corpus snapshot that is not a hash", () => {
    const source = RAW.abstention as unknown as DatasetInput<AbstentionItem>;
    expect(() => loadDataset(unhashed(source, abstention.items, "the march corpus"))).toThrow(
      /corpusSnapshot/,
    );
  });
});

describe("the held-out split is sealed (PRD 8.1)", () => {
  it("gives the development path only development items", () => {
    const sealed = seal(relevance);
    expect(sealed.development().map((item) => item.id)).toEqual(["rel-001", "rel-002"]);
  });

  it("requires a stated reason to read the held-out split", () => {
    expect(() => seal(relevance).unseal("   ")).toThrow(/requires a stated reason/);
  });

  it("records every unseal, so an artefact can carry why it read them", () => {
    const sealed = seal(relevance);
    const opened = sealed.unseal("final evaluation for the v1 evidence artefact");
    expect(opened.items.map((item) => item.id)).toEqual(["rel-003"]);
    expect(sealed.unseals()).toEqual(["final evaluation for the v1 evidence artefact"]);
  });
});

/* ------------------------------------------------------------------------ retrieval metrics */

describe("retrieval metrics (PRD 8.2)", () => {
  const items = relevance.items.filter((item) => item.split === "development");

  it("computes recall@k over the labelled relevant set", () => {
    // rel-001 has two relevant chunks; a run returning one of them recalls 0.5.
    // rel-002 has one; a run returning it recalls 1.
    const outcomes: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [A, C] },
      { itemId: "rel-002", ranked: [B] },
    ];
    const result = recallAt(10, items, outcomes);
    expect(result.perQuery).toEqual([
      { itemId: "rel-001", value: 0.5 },
      { itemId: "rel-002", value: 1 },
    ]);
    expect(result.value).toBe(0.75);
  });

  it("honours k", () => {
    const outcomes: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [C, A, B] },
      { itemId: "rel-002", ranked: [B] },
    ];
    expect(recallAt(1, items, outcomes).perQuery[0]?.value).toBe(0);
    expect(recallAt(3, items, outcomes).perQuery[0]?.value).toBe(1);
  });

  it("computes MRR from the first relevant position", () => {
    const outcomes: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [C, C, A] },
      { itemId: "rel-002", ranked: [B] },
    ];
    const result = meanReciprocalRank(items, outcomes);
    expect(result.perQuery[0]?.value).toBeCloseTo(1 / 3, 12);
    expect(result.perQuery[1]?.value).toBe(1);
  });

  it("scores MRR zero when nothing relevant was returned", () => {
    const outcomes: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [C] },
      { itemId: "rel-002", ranked: [C] },
    ];
    expect(meanReciprocalRank(items, outcomes).value).toBe(0);
  });

  it("scores a perfect ranking as 1", () => {
    const outcomes: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [A, B] },
      { itemId: "rel-002", ranked: [B] },
    ];
    expect(ndcgAt(10, items, outcomes).value).toBeCloseTo(1, 12);
  });

  it("uses graded gains, so two runs a binary metric ties are told apart", () => {
    // rel-001 labels A at 3 and B at 1. Both runs retrieve both chunks, so recall is identical;
    // only the order differs. A binary nDCG would score them the same, because binary gain cannot
    // see that A is the definitive passage and B a passing mention.
    const best: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [A, B] },
      { itemId: "rel-002", ranked: [B] },
    ];
    const worse: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [B, A] },
      { itemId: "rel-002", ranked: [B] },
    ];

    expect(recallAt(10, items, best).value).toBe(recallAt(10, items, worse).value);
    expect(ndcgAt(10, items, best).perQuery[0]?.value).toBeGreaterThan(
      ndcgAt(10, items, worse).perQuery[0]!.value,
    );

    // And the number is the graded one, worked out here rather than taken from the code:
    // DCG = (2^1-1)/log2(2) + (2^3-1)/log2(3) = 1 + 7/1.58496; IDCG = 7 + 1/1.58496.
    const dcg = 1 + 7 / Math.log2(3);
    const idcg = 7 + 1 / Math.log2(3);
    expect(ndcgAt(10, items, worse).perQuery[0]?.value).toBeCloseTo(dcg / idcg, 12);
  });

  it("takes the ideal ranking from every label, not from what was retrieved", () => {
    // A run that missed the grade-3 chunk entirely must not score 1 for ranking the grade-1 one
    // first, which is what an IDCG over the retrieved set would give it.
    const partial: RankedOutcome[] = [
      { itemId: "rel-001", ranked: [B] },
      { itemId: "rel-002", ranked: [B] },
    ];
    expect(ndcgAt(10, items, partial).perQuery[0]?.value).toBeLessThan(0.2);
  });

  it("attributes the relevant chunks each retriever found", () => {
    const outcomes: FusedOutcome[] = [
      {
        itemId: "rel-001",
        candidates: [fused(A, 1, ["dense"]), fused(B, 2, ["lexical", "dense"])],
      },
      { itemId: "rel-002", candidates: [fused(B, 1, ["lexical"])] },
    ];
    const results = perRetrieverContribution(items, outcomes);

    expect(results.map((result) => result.metric)).toEqual([
      "contribution:dense",
      "contribution:lexical",
    ]);
    // dense found both of rel-001's relevant chunks and none of rel-002's; lexical the reverse.
    expect(results[0]?.perQuery).toEqual([
      { itemId: "rel-001", value: 1 },
      { itemId: "rel-002", value: 0 },
    ]);
    expect(results[1]?.perQuery).toEqual([
      { itemId: "rel-001", value: 0.5 },
      { itemId: "rel-002", value: 1 },
    ]);
  });
});

/* ------------------------------------------------------------------------- citation metrics */

describe("citation metrics (PRD 8.2)", () => {
  const items = grounded.items.filter((item) => item.split === "development");
  const blocks = [
    { chunkId: A, text: "a passage long enough" },
    { chunkId: B, text: "another passage" },
  ];

  it("computes precision over what was cited", () => {
    const outcomes: AnswerOutcome[] = [
      { itemId: "grd-001", answer: answer([{ chunkId: A, sourceVersionId: VERSION_A }]), blocks },
      {
        itemId: "grd-002",
        answer: answer([
          { chunkId: B, sourceVersionId: VERSION_B },
          { chunkId: A, sourceVersionId: VERSION_A },
        ]),
        blocks,
      },
    ];
    // grd-001 cited one chunk, correctly. grd-002 cited two, one of them correct.
    expect(citationPrecision(items, outcomes).perQuery).toEqual([
      { itemId: "grd-001", value: 1 },
      { itemId: "grd-002", value: 0.5 },
    ]);
  });

  it("computes recall over what should have been cited", () => {
    const outcomes: AnswerOutcome[] = [
      { itemId: "grd-001", answer: answer([{ chunkId: C, sourceVersionId: VERSION_A }]), blocks },
      { itemId: "grd-002", answer: answer([{ chunkId: B, sourceVersionId: VERSION_B }]), blocks },
    ];
    expect(citationRecall(items, outcomes).perQuery).toEqual([
      { itemId: "grd-001", value: 0 },
      { itemId: "grd-002", value: 1 },
    ]);
  });

  it("excludes an abstention from precision rather than scoring it perfect", () => {
    // A system that never answers would otherwise be perfectly precise.
    const outcomes: AnswerOutcome[] = [
      { itemId: "grd-001", answer: ABSTAINED, blocks },
      { itemId: "grd-002", answer: answer([{ chunkId: B, sourceVersionId: VERSION_B }]), blocks },
    ];
    const result = citationPrecision(items, outcomes);
    expect(result.sampleSize).toBe(1);
    expect(result.perQuery.map((score) => score.itemId)).toEqual(["grd-002"]);
  });

  it("scores an abstention as a recall miss, because the material existed", () => {
    const outcomes: AnswerOutcome[] = [
      { itemId: "grd-001", answer: ABSTAINED, blocks },
      { itemId: "grd-002", answer: ABSTAINED, blocks },
    ];
    expect(citationRecall(items, outcomes).value).toBe(0);
  });

  it("scores span validity against the passage the model was shown", () => {
    const shortBlock = [{ chunkId: A, text: "abc" }];
    const outcomes: AnswerOutcome[] = [
      {
        itemId: "grd-001",
        answer: answer([{ chunkId: A, sourceVersionId: VERSION_A }]),
        blocks: shortBlock,
      },
    ];
    // The reference spans 0–5 into a three-character passage.
    expect(spanValidityRate(outcomes).value).toBe(0);
  });

  it("is 1 over answers that passed verification, which is the gate holding", () => {
    const outcomes: AnswerOutcome[] = [
      { itemId: "grd-001", answer: answer([{ chunkId: A, sourceVersionId: VERSION_A }]), blocks },
    ];
    expect(spanValidityRate(outcomes).value).toBe(1);
  });
});

/* ------------------------------------------------------------------------ abstention metrics */

describe("abstention metrics (PRD 8.2, 7.3)", () => {
  const items = abstention.items.filter((item) => item.split === "development");

  it("scores the queries where refusal is correct", () => {
    const outcomes: AbstentionOutcome[] = [
      { itemId: "abs-001", abstained: true },
      { itemId: "abs-002", abstained: false },
      { itemId: "abs-003", abstained: false },
    ];
    const result = correctAbstentionRate(items, outcomes);
    expect(result.sampleSize).toBe(2);
    expect(result.value).toBe(0.5);
  });

  it("scores the answerable queries separately", () => {
    const outcomes: AbstentionOutcome[] = [
      { itemId: "abs-001", abstained: true },
      { itemId: "abs-002", abstained: true },
      { itemId: "abs-003", abstained: true },
    ];
    const over = overAbstentionRate(items, outcomes);
    expect(over.sampleSize).toBe(1);
    expect(over.value).toBe(1);
  });

  it("separates the two failures a single accuracy score would merge", () => {
    const never: AbstentionOutcome[] = items.map((item) => ({ itemId: item.id, abstained: false }));
    const always: AbstentionOutcome[] = items.map((item) => ({ itemId: item.id, abstained: true }));

    expect(correctAbstentionRate(items, never).value).toBe(0);
    expect(overAbstentionRate(items, never).value).toBe(0);
    expect(correctAbstentionRate(items, always).value).toBe(1);
    expect(overAbstentionRate(items, always).value).toBe(1);
  });

  it("refuses a set with no answerable query", () => {
    const onlyUnanswerable = items.filter((item) => item.shouldAbstain);
    expect(() =>
      overAbstentionRate(
        onlyUnanswerable,
        onlyUnanswerable.map((item) => ({ itemId: item.id, abstained: true })),
      ),
    ).toThrow(/rewards a system that never answers/);
  });
});

/* ------------------------------------------------------------------------ governance metrics */

describe("governance metrics have a different gate (PRD 8.4)", () => {
  const items = probes.items.filter((item) => item.split === "development");
  const clean: ProbeOutcome[] = [
    { itemId: "prb-001", materialised: [], message: abstentionMessage("nothing-relevant") },
    { itemId: "prb-002", materialised: [A], message: "The refund window is 30 days." },
  ];

  it("counts a leak as a sum, not a rate", () => {
    const leaked: ProbeOutcome[] = [
      { itemId: "prb-001", materialised: [D], message: abstentionMessage("nothing-relevant") },
      { itemId: "prb-002", materialised: [A], message: "The refund window is 30 days." },
    ];
    const result = leakCount(items, leaked);
    expect(result.aggregation).toBe("sum");
    expect(result.value).toBe(1);
  });

  it("counts a forbidden chunk that reached the candidate set but was never cited", () => {
    // PRD 6.2: no unreadable chunk may be materialised into the candidate set or the prompt. It
    // was read by the model, and the prose is downstream of it.
    const leaked: ProbeOutcome[] = [
      { itemId: "prb-001", materialised: [D], message: abstentionMessage("nothing-relevant") },
      { itemId: "prb-002", materialised: [], message: abstentionMessage("nothing-relevant") },
    ];
    expect(leakCount(items, leaked).value).toBe(1);
  });

  it("fails the build rather than returning a score", () => {
    const leaked: ProbeOutcome[] = [
      { itemId: "prb-001", materialised: [D], message: abstentionMessage("nothing-relevant") },
      { itemId: "prb-002", materialised: [], message: abstentionMessage("nothing-relevant") },
    ];
    expect(() => assertNoLeaks(items, leaked)).toThrow(/build failure and not a score decline/);
  });

  it("names which probe leaked which chunk", () => {
    const leaked: ProbeOutcome[] = [
      { itemId: "prb-001", materialised: [D], message: abstentionMessage("nothing-relevant") },
      { itemId: "prb-002", materialised: [], message: abstentionMessage("nothing-relevant") },
    ];
    try {
      assertNoLeaks(items, leaked);
      expect.unreachable("a leak must throw");
    } catch (error) {
      expect((error as Error).message).toContain("prb-001");
      expect((error as Error).message).toContain(D);
    }
  });

  it("passes a clean run and reports both counts", () => {
    const gate = assertNoLeaks(items, clean);
    expect(gate.passed).toBe(true);
    expect(gate.leaks.value).toBe(0);
  });

  it("refuses to count a probe that did not run as clean", () => {
    expect(() => leakCount(items, [clean[0]!])).toThrow(/did not run/);
  });

  it("counts an existence disclosure where the principal may not learn that material exists", () => {
    const disclosed: ProbeOutcome[] = [
      {
        itemId: "prb-001",
        materialised: [],
        message: abstentionMessage("excluded-visible"),
      },
      { itemId: "prb-002", materialised: [A], message: "The refund window is 30 days." },
    ];
    expect(existenceDisclosureCount(items, disclosed).value).toBe(1);
  });

  it("does not count one where disclosure is permitted", () => {
    const disclosed: ProbeOutcome[] = [
      { itemId: "prb-001", materialised: [], message: abstentionMessage("nothing-relevant") },
      { itemId: "prb-002", materialised: [], message: abstentionMessage("excluded-visible") },
    ];
    expect(existenceDisclosureCount(items, disclosed).value).toBe(0);
  });

  it("compares against governance's own wording rather than a copy of it", () => {
    // Two identical literals drift, and the drift is silent: the wording improves in one place and
    // this metric stops recognising it, so the count falls to zero for the wrong reason.
    const disclosed: ProbeOutcome[] = [
      { itemId: "prb-001", materialised: [], message: abstentionMessage("excluded-hidden") },
      { itemId: "prb-002", materialised: [], message: abstentionMessage("nothing-relevant") },
    ];
    expect(existenceDisclosureCount(items, disclosed).value).toBe(0);
  });
});

/* -------------------------------------------------------------------------- the metric shape */

describe("per-query scores are retained, not only aggregates (PRD 8.5)", () => {
  it("has no constructor that takes an aggregate", () => {
    const result = metricResult("m", [
      { itemId: "q1", value: 1 },
      { itemId: "q2", value: 0 },
    ]);
    expect(result.value).toBe(0.5);
    expect(result.perQuery).toHaveLength(2);
  });

  it("refuses a metric over zero queries", () => {
    expect(() => metricResult("m", [])).toThrow(/undefined/);
  });

  it("refuses a non-finite per-query score", () => {
    expect(() => metricResult("m", [{ itemId: "q1", value: Number.NaN }])).toThrow(/q1/);
  });

  it("pairs two runs by item, which is what the bootstrap in P10b needs", () => {
    const before = metricResult("m", [
      { itemId: "q1", value: 0.5 },
      { itemId: "q2", value: 1 },
    ]);
    const after = metricResult("m", [
      { itemId: "q1", value: 0.75 },
      { itemId: "q2", value: 1 },
      { itemId: "q3", value: 1 },
    ]);

    // q3 is dropped: an item only one run scored cannot contribute a delta, and counting it as
    // zero would dilute the comparison with queries that were never compared.
    expect(pairScores(before, after)).toEqual([
      { itemId: "q1", delta: 0.25 },
      { itemId: "q2", delta: 0 },
    ]);
  });
});
