/**
 * Corpus inventory tests (P14a).
 *
 * Two things are being protected here, and neither is the JSON.
 *
 * The first is that the committed inventory still describes the corpus on disk. Every label P14b
 * writes points at a chunk identifier this file pins, and identifiers are derived from a source
 * version and an ordinal — so editing a document moves them. Nothing would break loudly: the
 * labels would point at chunks that no longer exist, every metric would still compute, and the
 * numbers would quietly be about a smaller corpus.
 *
 * The second is that the corpus still has zones. A permission probe over a corpus where everybody
 * reads everything measures nothing at all, and that is a property of the fixtures rather than of
 * the code — exactly the kind of thing that decays without a test.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildInventory, renderInventory, INVENTORY_FILE } from "./inventory.js";

const inventory = await buildInventory();

describe("the committed inventory", () => {
  it("matches a fresh ingestion of examples/corpus", () => {
    // The same check `pnpm corpus:check` runs, as a test, so a corpus edit fails the suite too.
    expect(readFileSync(INVENTORY_FILE, "utf8")).toBe(renderInventory(inventory));
  });

  it("records the snapshot hash a dataset pins itself to", () => {
    expect(inventory.corpusSnapshot).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records the chunking settings that produced these identifiers", () => {
    // A tool that inventoried at a different token budget would produce identifiers the evaluation
    // runner never creates — the labels would point at nothing while the snapshot matched.
    expect(inventory.chunking).toEqual({ maxTokens: 256, boundaryDepth: 2 });
  });

  it("names the embedder, so nobody reads these vectors as somebody's real ones", () => {
    expect(inventory.embedder).toBe("stand-in-embedder");
  });
});

describe("the corpus has zones", () => {
  const zones = new Set(inventory.sources.flatMap((source) => source.readableBy));

  it("holds material in more than one access zone", () => {
    expect(zones.size).toBeGreaterThan(1);
  });

  it("holds material an engineering principal must not read", () => {
    // prn_alice is engineering in examples/corpus.groups.json. Without a zone she cannot read,
    // the leak count in P14b would be zero by arithmetic rather than by enforcement.
    const forbidden = inventory.sources.filter(
      (source) => !source.readableBy.includes("grp_engineering"),
    );
    expect(forbidden.length).toBeGreaterThan(0);
    expect(forbidden.flatMap((source) => source.chunks).length).toBeGreaterThan(0);
  });

  it("holds a hidden source, so the existence oracle has something to hide", () => {
    // PRD 6.4: for a hidden source the answer must be byte-identical to "nothing was found".
    const hidden = inventory.sources.filter((source) => source.existence === "hidden");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.readableBy).not.toContain("grp_everyone");
  });

  it("keeps vocabulary shared across a zone boundary", () => {
    // The finance material deliberately reuses the support handbook's words, so that a query a
    // support agent may ask has something tempting and forbidden sitting beside the answer. A
    // corpus whose zones share no vocabulary makes the pre-filter look better than it is.
    const opensOf = (predicate: (readableBy: readonly string[]) => boolean): string =>
      inventory.sources
        .filter((source) => predicate(source.readableBy))
        .flatMap((source) => source.chunks.map((chunk) => chunk.opens))
        .join(" ")
        .toLowerCase();

    const open = opensOf((groups) => groups.includes("grp_everyone"));
    const finance = opensOf((groups) => groups.includes("grp_finance"));

    expect(open).toContain("refund");
    expect(finance).toContain("refund");
  });
});
