/**
 * Parsing and chunking tests (P6a).
 *
 * The fixture is a real Markdown document with the five constructs PRD 4.3 names, read as bytes
 * rather than built as a string literal — a literal would be reindented by the next person who
 * tidied this file, and every offset assertion below would move with it.
 *
 * Two invariants are checked over and over rather than once, because everything else depends on
 * them: **a chunk is a contiguous slice of its source**, and **chunking the same bytes twice
 * produces the same chunks**. The first is what makes a citation verifiable; the second is PRD
 * 4.5's determinism row.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertSingleEmbeddingModel,
  contentHashOf,
  decomposeChunkId,
  formatSourceVersionId,
  parseGroupId,
  parseSourceId,
  parseSourceVersion,
  type EmbeddingModelRef,
  type SourceVersion,
} from "@atlasops/contracts";
import { describe, expect, it } from "vitest";

import { chunksFor, textOf } from "./assemble.js";
import { boundaryKey, commonPrefix, flatten, type Heading } from "./document.js";
import { parseDocument } from "./markdown.js";
import { byLine, byWhitespace, byWidth, splitToBudget, type Range } from "./ranges.js";
import { fixedWidth, structureAware } from "./strategy.js";
import { approximateTokenCounter } from "./tokens.js";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../fixtures/handbook.md", import.meta.url)),
  "utf8",
);

const EMBEDDING: EmbeddingModelRef = { id: "fake-embedder", dimension: 32 };

function versionFor(text: string): SourceVersion {
  const contentHash = contentHashOf(text);
  return parseSourceVersion({
    sourceId: parseSourceId("src_handbook", "fixture"),
    sourceVersionId: formatSourceVersionId(contentHash),
    contentHash,
    observedAt: "2026-03-01T00:00:00.000Z",
    effectiveDate: "2026-03-01T00:00:00.000Z",
    upstreamRevision: "r1",
    supersedes: null,
    acl: { readableBy: [parseGroupId("grp_engineering", "fixture")], existence: "visible" },
  });
}

const VERSION = versionFor(SOURCE);

function isLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

function covers(ranges: readonly Range[], range: Range): boolean {
  if (ranges.length === 0) return range.end === range.start;
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) return false;
  if (first.start !== range.start || last.end !== range.end) return false;
  return ranges.every((current, index) => index === 0 || ranges[index - 1]?.end === current.start);
}

/* ------------------------------------------------------------------------------- the parser */

describe("the parser recognises exactly what PRD 4.3 names", () => {
  const document = parseDocument(SOURCE);
  const placed = flatten(document);

  it("nests sections by heading depth", () => {
    const top = document.children[0];
    expect(top?.heading).toEqual({ text: "Engineering handbook", depth: 1 });
    expect(top?.children.map((child) => child.heading?.text)).toEqual([
      "On-call",
      "Retention",
      "Draining the ingest worker",
    ]);
  });

  it("nests a deeper heading under the section it follows", () => {
    const onCall = document.children[0]?.children[0];
    expect(onCall?.children.map((child) => child.heading?.text)).toEqual([
      "Escalation",
      "Handover",
    ]);
  });

  it("finds a table, a code block and a list, each as one block", () => {
    const kinds = placed.map((entry) => entry.block.kind);
    expect(kinds.filter((kind) => kind === "table")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "code")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "list")).toHaveLength(1);
  });

  it("keeps the whole table in one block, header row included", () => {
    const table = placed.find((entry) => entry.block.kind === "table");
    const text = SOURCE.slice(table?.block.charStart ?? 0, table?.block.charEnd ?? 0);
    expect(text.split("\n")).toHaveLength(5);
    expect(text.startsWith("| Artefact")).toBe(true);
  });

  it("keeps the whole list in one block", () => {
    const list = placed.find((entry) => entry.block.kind === "list");
    const text = SOURCE.slice(list?.block.charStart ?? 0, list?.block.charEnd ?? 0);
    expect(text.split("\n")).toHaveLength(3);
  });

  it("gives every block a non-empty, in-order, non-overlapping span", () => {
    let previous = -1;
    for (const entry of placed) {
      expect(entry.block.charEnd).toBeGreaterThan(entry.block.charStart);
      expect(entry.block.charStart).toBeGreaterThan(previous);
      previous = entry.block.charEnd;
    }
  });

  it("carries the heading path down to the deepest block", () => {
    const list = placed.find((entry) => entry.block.kind === "list");
    expect(list?.headingPath.map((heading) => heading.text)).toEqual([
      "Engineering handbook",
      "On-call",
      "Escalation",
    ]);
  });

  it("does not let a hash inside a code fence open a section", () => {
    // The failure this prevents is a boundary cut through somebody's code sample.
    const document = parseDocument("# Title\n\n```sh\n# not a heading\necho hi\n```\n");
    expect(document.children[0]?.children).toEqual([]);
    expect(document.children[0]?.blocks[0]?.kind).toBe("code");
  });

  it("runs an unterminated fence to the end rather than reinterpreting it as prose", () => {
    const text = "# Title\n\n```sh\n# still code\n## still code\n";
    const document = parseDocument(text);
    expect(document.children[0]?.children).toEqual([]);
    expect(document.children[0]?.blocks[0]?.charEnd).toBe(text.length - 1);
  });

  it("ends a table block at the first line that is not a row", () => {
    const document = parseDocument("| a |\n| b |\nprose\n");
    expect(document.blocks.map((block) => block.kind)).toEqual(["table", "paragraph"]);
  });

  it("keeps an indented continuation line inside its list item", () => {
    const document = parseDocument("- first\n  continued\n- second\n");
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]?.kind).toBe("list");
  });

  it("trims a closing hash run from a heading", () => {
    expect(parseDocument("## Title ##\n").children[0]?.heading?.text).toBe("Title");
  });

  it("returns an empty root for an empty document", () => {
    const document = parseDocument("");
    expect(document.blocks).toEqual([]);
    expect(document.children).toEqual([]);
  });
});

describe("heading paths and boundaries", () => {
  const deep: readonly Heading[] = [
    { text: "Handbook", depth: 1 },
    { text: "On-call", depth: 2 },
    { text: "Escalation", depth: 3 },
  ];

  it("ignores headings deeper than the boundary depth", () => {
    expect(boundaryKey(deep, 2)).toBe(boundaryKey(deep.slice(0, 2), 2));
  });

  it("separates two sections at the boundary depth", () => {
    const other: readonly Heading[] = [
      { text: "Handbook", depth: 1 },
      { text: "Retention", depth: 2 },
    ];
    expect(boundaryKey(deep, 2)).not.toBe(boundaryKey(other, 2));
  });

  it("returns the shared prefix of two paths and nothing beyond it", () => {
    const sibling: readonly Heading[] = [
      { text: "Handbook", depth: 1 },
      { text: "On-call", depth: 2 },
      { text: "Handover", depth: 3 },
    ];
    expect(commonPrefix(deep, sibling).map((heading) => heading.text)).toEqual([
      "Handbook",
      "On-call",
    ]);
  });
});

/* ------------------------------------------------------------------------------- segmenting */

describe("segmenters cover their range without gaps", () => {
  const whole: Range = { start: 0, end: SOURCE.length };

  it("byLine covers the document contiguously", () => {
    expect(covers(byLine(SOURCE, whole), whole)).toBe(true);
  });

  it("byWhitespace covers the document contiguously", () => {
    expect(covers(byWhitespace(SOURCE, whole), whole)).toBe(true);
  });

  it("byWidth covers the document contiguously", () => {
    expect(covers(byWidth(37)(SOURCE, whole), whole)).toBe(true);
  });

  it("byWhitespace never cuts inside a word", () => {
    for (const range of byWhitespace(SOURCE, whole)) {
      if (range.start === 0) continue;
      expect(/\s/.test(SOURCE[range.start - 1] ?? "")).toBe(true);
    }
  });
});

describe("splitting an oversized block", () => {
  const placed = flatten(parseDocument(SOURCE));

  it("cuts a table only between rows", () => {
    const table = placed.find((entry) => entry.block.kind === "table");
    expect(table).toBeDefined();
    const range = { start: table!.block.charStart, end: table!.block.charEnd };

    const pieces = splitToBudget(
      SOURCE,
      range,
      [byLine, byWhitespace, byWidth(60)],
      12,
      approximateTokenCounter,
    );

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(isLineStart(SOURCE, piece.start)).toBe(true);
    expect(covers(pieces, range)).toBe(true);
  });

  it("cuts a code block only between lines", () => {
    const code = placed.find((entry) => entry.block.kind === "code");
    expect(code).toBeDefined();
    const range = { start: code!.block.charStart, end: code!.block.charEnd };

    const pieces = splitToBudget(
      SOURCE,
      range,
      [byLine, byWhitespace, byWidth(60)],
      12,
      approximateTokenCounter,
    );

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(isLineStart(SOURCE, piece.start)).toBe(true);
  });

  it("falls through to the backstop for an unbroken run, rather than not terminating", () => {
    const blob = "x".repeat(500);
    const pieces = splitToBudget(
      blob,
      { start: 0, end: blob.length },
      [byLine, byWhitespace, byWidth(40)],
      10,
      approximateTokenCounter,
    );

    expect(pieces.length).toBeGreaterThan(1);
    expect(covers(pieces, { start: 0, end: blob.length })).toBe(true);
  });

  it("returns a range whole when no segmenter can divide it", () => {
    const blob = "y".repeat(100);
    const pieces = splitToBudget(
      blob,
      { start: 0, end: blob.length },
      [byLine, byWhitespace],
      1,
      approximateTokenCounter,
    );
    expect(pieces).toEqual([{ start: 0, end: blob.length }]);
  });
});

/* -------------------------------------------------------------------------- structure-aware */

describe("the structure-aware chunker (PRD 4.3)", () => {
  const strategy = structureAware({ maxTokens: 400, boundaryDepth: 2 });
  const drafts = strategy.chunk(SOURCE, approximateTokenCounter);

  it("produces the same chunks from the same bytes, every time", () => {
    const again = structureAware({ maxTokens: 400, boundaryDepth: 2 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );
    expect(again).toEqual(drafts);
  });

  it("emits every chunk as a contiguous slice of the source", () => {
    for (const draft of drafts) {
      expect(draft.text).toBe(SOURCE.slice(draft.charStart, draft.charEnd));
    }
  });

  it("emits chunks in document order", () => {
    for (let index = 1; index < drafts.length; index += 1) {
      expect(drafts[index]!.charStart).toBeGreaterThanOrEqual(drafts[index - 1]!.charStart);
    }
  });

  it("packs across a deeper heading when the boundary depth allows it", () => {
    const merged = drafts.find(
      (draft) => draft.text.includes("Page the secondary") && draft.text.includes("handover note"),
    );
    expect(merged).toBeDefined();
    expect(merged?.headingPath).toEqual(["Engineering handbook", "On-call"]);
  });

  it("does not pack across a heading at the boundary depth", () => {
    const crossed = drafts.find(
      (draft) => draft.text.includes("Page the secondary") && draft.text.includes("ninety days"),
    );
    expect(crossed).toBeUndefined();
  });

  it("stops packing at a deeper heading once the boundary depth reaches it", () => {
    const deeper = structureAware({ maxTokens: 400, boundaryDepth: 3 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );
    const merged = deeper.find(
      (draft) => draft.text.includes("Page the secondary") && draft.text.includes("handover note"),
    );
    expect(merged).toBeUndefined();
  });

  it("gives a packed chunk the heading path its members share", () => {
    for (const draft of drafts) {
      expect(draft.headingPath[0]).toBe("Engineering handbook");
    }
  });

  it("keeps chunks within the budget when the blocks allow it", () => {
    for (const draft of drafts) expect(draft.tokenCount).toBeLessThanOrEqual(400);
  });

  it("cuts an oversized table between rows rather than mid-row", () => {
    const tight = structureAware({ maxTokens: 12, boundaryDepth: 2 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );
    const rows = tight.filter((draft) => draft.text.startsWith("| "));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(isLineStart(SOURCE, row.charStart)).toBe(true);
      expect(row.text.endsWith("|")).toBe(true);
    }
  });

  it("reports no empty chunk, whatever the budget", () => {
    for (const budget of [8, 12, 50, 400, 5000]) {
      const produced = structureAware({ maxTokens: budget, boundaryDepth: 2 }).chunk(
        SOURCE,
        approximateTokenCounter,
      );
      for (const draft of produced) {
        expect(draft.text.trim().length).toBeGreaterThan(0);
        expect(draft.charEnd).toBeGreaterThan(draft.charStart);
      }
    }
  });

  it("names itself, so a run can record which strategy produced a chunk set", () => {
    expect(strategy.name).toBe("structure-aware(max=400,depth=2)");
  });
});

/* ------------------------------------------------------------------------------ fixed width */

describe("the fixed-width fallback (PRD 4.3)", () => {
  it("produces the same chunks from the same bytes", () => {
    const options = { maxTokens: 60, overlapTokens: 0 };
    expect(fixedWidth(options).chunk(SOURCE, approximateTokenCounter)).toEqual(
      fixedWidth(options).chunk(SOURCE, approximateTokenCounter),
    );
  });

  it("emits every chunk as a contiguous slice", () => {
    for (const draft of fixedWidth({ maxTokens: 60, overlapTokens: 0 }).chunk(
      SOURCE,
      approximateTokenCounter,
    )) {
      expect(draft.text).toBe(SOURCE.slice(draft.charStart, draft.charEnd));
    }
  });

  it("emits an empty heading path, because it recovered no structure", () => {
    for (const draft of fixedWidth({ maxTokens: 60, overlapTokens: 0 }).chunk(
      SOURCE,
      approximateTokenCounter,
    )) {
      expect(draft.headingPath).toEqual([]);
    }
  });

  it("produces disjoint windows with no overlap configured", () => {
    const drafts = fixedWidth({ maxTokens: 60, overlapTokens: 0 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );
    for (let index = 1; index < drafts.length; index += 1) {
      expect(drafts[index]!.charStart).toBeGreaterThanOrEqual(drafts[index - 1]!.charEnd);
    }
  });

  it("repeats a real prefix of the source when overlap is configured", () => {
    const drafts = fixedWidth({ maxTokens: 60, overlapTokens: 15 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts[1]!.charStart).toBeLessThan(drafts[0]!.charEnd);
    // Still a slice: overlap is where the window starts, not text spliced in.
    expect(drafts[1]!.text).toBe(SOURCE.slice(drafts[1]!.charStart, drafts[1]!.charEnd));
  });

  it("terminates on a single word longer than the budget", () => {
    const drafts = fixedWidth({ maxTokens: 5, overlapTokens: 2 }).chunk(
      "z".repeat(400),
      approximateTokenCounter,
    );
    expect(drafts).toHaveLength(1);
  });

  it("returns nothing for whitespace", () => {
    expect(
      fixedWidth({ maxTokens: 10, overlapTokens: 0 }).chunk("   \n\n ", approximateTokenCounter),
    ).toEqual([]);
  });
});

describe("the strategy is chosen per source, not globally", () => {
  it("chunks the same text two different ways in one run", () => {
    const structural = structureAware({ maxTokens: 60, boundaryDepth: 2 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );
    const flat = fixedWidth({ maxTokens: 60, overlapTokens: 0 }).chunk(
      SOURCE,
      approximateTokenCounter,
    );

    expect(structural).not.toEqual(flat);
    expect(structural.some((draft) => draft.headingPath.length > 0)).toBe(true);
    expect(flat.every((draft) => draft.headingPath.length === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ the chunk payload */

describe("the chunk payload (PRD 4.4)", () => {
  const strategy = structureAware({ maxTokens: 120, boundaryDepth: 2 });
  const chunks = chunksFor({ version: VERSION, text: SOURCE, strategy, embedding: EMBEDDING });

  it("produces chunks that pass the contract's own validator", () => {
    // chunksFor returns only what parseChunk accepted, so reaching here at all is the assertion.
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("derives every chunk identifier from its version and ordinal", () => {
    chunks.forEach((chunk, ordinal) => {
      expect(chunk.ordinal).toBe(ordinal);
      expect(decomposeChunkId(chunk.chunkId)).toEqual({
        sourceVersionId: VERSION.sourceVersionId,
        ordinal,
      });
    });
  });

  it("carries a content hash that matches the text at its own offsets", () => {
    for (const chunk of chunks) {
      expect(contentHashOf(textOf(chunk, SOURCE))).toBe(chunk.contentHash);
    }
  });

  it("carries the version's source, effective date and access label", () => {
    for (const chunk of chunks) {
      expect(chunk.sourceId).toBe(VERSION.sourceId);
      expect(chunk.effectiveDate).toBe(VERSION.effectiveDate);
      expect(chunk.acl).toEqual(VERSION.acl);
    }
  });

  it("records the embedding model on every chunk, so the set is not mixed", () => {
    expect(assertSingleEmbeddingModel(chunks)).toEqual(EMBEDDING);
  });

  it("carries a heading path, so a passage can be rendered with its location", () => {
    expect(chunks.some((chunk) => chunk.headingPath.length > 1)).toBe(true);
  });

  it("produces a byte-identical chunk set on re-ingestion (PRD 4.5)", () => {
    const again = chunksFor({ version: VERSION, text: SOURCE, strategy, embedding: EMBEDDING });
    expect(again.map((chunk) => chunk.chunkId)).toEqual(chunks.map((chunk) => chunk.chunkId));
    expect(again.map((chunk) => chunk.contentHash)).toEqual(
      chunks.map((chunk) => chunk.contentHash),
    );
  });

  it("refuses to chunk text that is not the version's bytes", () => {
    // The failure this catches produces a perfectly valid chunk set whose every offset points
    // into a document nobody has.
    expect(() =>
      chunksFor({ version: VERSION, text: `${SOURCE} `, strategy, embedding: EMBEDDING }),
    ).toThrow(/hashes to/);
  });

  it("accepts a different tokenizer without changing anything else", () => {
    const doubled = chunksFor({
      version: VERSION,
      text: SOURCE,
      strategy,
      embedding: EMBEDDING,
      tokenCounter: (text) => text.length,
    });
    // A counter that reports four times as many tokens produces more, smaller chunks.
    expect(doubled.length).toBeGreaterThan(chunks.length);
  });
});
