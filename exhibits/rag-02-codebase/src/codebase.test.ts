/**
 * RAG-02 tests.
 *
 * Three claims, each of which can be wrong while everything still runs:
 *
 * 1. **A chunk is a declaration.** A boundary in the wrong place makes a citation that points at
 *    half a function, and nothing about a half-function citation looks broken.
 * 2. **A citation is a line range in a version.** Computed against the wrong bytes it points at
 *    plausible, wrong code.
 * 3. **Nothing crosses a repository boundary** — not a retrieved chunk, which the platform's
 *    pre-filter prevents, and not a call-graph edge, which this exhibit prevents by never recording
 *    one. The second is the one only this exhibit could get wrong.
 *
 * Nothing calls a paid API; every model is the in-repo stand-in.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { approximateTokenCounter } from "@atlasops/ingest";
import { contentHashOf, formatSourceVersionId } from "@atlasops/contracts";
import { describe, expect, it } from "vitest";

import { createAssistant } from "./assistant.js";
import { buildCallGraph } from "./callgraph.js";
import { chunksForSymbol, evaluate, loadCodebaseDataset } from "./evaluate.js";
import { VersionMismatch, lineRangeOf, linesInVersion, renderLines } from "./lines.js";
import { symbolAware } from "./strategy.js";
import { calledNames, topLevelSymbols } from "./symbols.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "..", "fixtures");

const SOURCE = [
  "/**",
  " * The module's own introduction.",
  " */",
  "",
  'import { thing } from "./thing";',
  "",
  "export interface Options {",
  "  readonly size: number;",
  "}",
  "",
  "/** Doubles a number. */",
  "export function double(value: number): number {",
  "  return helper(value) * 2;",
  "}",
  "",
  "function helper(value: number): number {",
  "  return value;",
  "}",
  "",
  "export const A = 1, B = 2;",
  "",
].join("\n");

/* ------------------------------------------------------------------------------ symbols */

describe("symbols come from the compiler's parser", () => {
  const symbols = topLevelSymbols("source.ts", SOURCE);

  it("finds every top-level declaration with its kind", () => {
    expect(symbols.map((symbol) => `${symbol.kind} ${symbol.name}`)).toEqual([
      "interface Options",
      "function double",
      "function helper",
      "const A",
      "const B",
    ]);
  });

  it("includes a declaration's own doc comment", () => {
    const double = symbols.find((symbol) => symbol.name === "double");
    expect(SOURCE.slice(double?.charStart, double?.charEnd)).toMatch(/^\/\*\* Doubles a number/);
  });

  it("does not give the file's introduction to the first declaration", () => {
    // The first run of this exhibit cited an interface from line 1, because the compiler attaches
    // every leading doc comment to the next declaration — including the file's header.
    const options = symbols.find((symbol) => symbol.name === "Options");
    expect(SOURCE.slice(options?.charStart, options?.charEnd)).toMatch(/^export interface Options/);
  });

  it("gives several names from one statement one shared range", () => {
    const a = symbols.find((symbol) => symbol.name === "A");
    const b = symbols.find((symbol) => symbol.name === "B");
    expect([a?.charStart, a?.charEnd]).toEqual([b?.charStart, b?.charEnd]);
  });

  it("records who a declaration calls", () => {
    const double = symbols.find((symbol) => symbol.name === "double");
    expect(double).toBeDefined();
    if (double === undefined) return;
    expect(calledNames("source.ts", SOURCE, double)).toEqual(["helper"]);
  });
});

/* ----------------------------------------------------------------------------- chunking */

describe("a chunk is a declaration", () => {
  const drafts = symbolAware({ maxTokens: 200 }).chunk(SOURCE, approximateTokenCounter);

  it("produces one chunk per declaration, named after it", () => {
    expect(drafts.map((draft) => draft.headingPath)).toEqual([
      ["interface Options"],
      ["function double"],
      ["function helper"],
      ["const A", "const B"],
    ]);
  });

  it("keeps every chunk a contiguous slice of the source", () => {
    // The property PRD 4.4's offsets and PRD 7.2's verification both depend on.
    for (const draft of drafts) {
      expect(SOURCE.slice(draft.charStart, draft.charEnd)).toBe(draft.text);
    }
  });

  it("puts import lines in no chunk", () => {
    expect(drafts.some((draft) => draft.text.includes("import {"))).toBe(false);
  });

  it("cuts an oversized declaration between lines and names every piece after it", () => {
    const long = [
      "export function long(): number {",
      ...Array.from(
        { length: 40 },
        (_, index) => `  const value${String(index)} = ${String(index)};`,
      ),
      "  return 0;",
      "}",
    ].join("\n");

    const pieces = symbolAware({ maxTokens: 40 }).chunk(long, approximateTokenCounter);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.headingPath).toEqual(["function long"]);
      // Cut at a line boundary: every piece starts at the beginning of a line.
      expect(
        piece.charStart === 0 ||
          long[piece.charStart - 1] === "\n" ||
          /\s/.test(long[piece.charStart - 1] ?? ""),
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------- lines */

describe("a citation is a line range in a version", () => {
  const text = "one\ntwo\nthree\n";

  it("numbers lines from one, inclusively", () => {
    expect(lineRangeOf(text, 4, 7)).toEqual({ startLine: 2, endLine: 2 });
    expect(lineRangeOf(text, 0, 13)).toEqual({ startLine: 1, endLine: 3 });
  });

  it("does not claim the line after a range that ends on a newline", () => {
    // `charEnd` is exclusive. Without this every whole-declaration citation ends one line late.
    expect(lineRangeOf(text, 0, 4)).toEqual({ startLine: 1, endLine: 1 });
  });

  it("refuses bytes that are not the cited version", () => {
    const version = formatSourceVersionId(contentHashOf(text));
    expect(() => linesInVersion(`${text}four\n`, version, 0, 3)).toThrow(VersionMismatch);
    expect(linesInVersion(text, version, 0, 3)).toEqual({ startLine: 1, endLine: 1 });
  });

  it("renders the form an editor understands", () => {
    expect(renderLines("a/b.ts", { startLine: 3, endLine: 9 })).toBe("a/b.ts:3-9");
    expect(renderLines("a/b.ts", { startLine: 4, endLine: 4 })).toBe("a/b.ts:4");
  });
});

/* --------------------------------------------------------------------------- call graph */

describe("the call graph never crosses a repository boundary", () => {
  const files = [
    {
      path: "platform/retry.ts",
      text: "export function withRetry(): void { backoff(); }\nexport function backoff(): void {}\n",
    },
    {
      path: "payments/refunds.ts",
      text: "export function issueRefund(): void { withRetry(); record(); }\nfunction record(): void {}\n",
    },
  ];
  const graph = buildCallGraph(files);

  it("records a call within a repository", () => {
    expect(graph.callersOf({ path: "platform/retry.ts", name: "backoff" })).toEqual([
      { path: "platform/retry.ts", name: "withRetry" },
    ]);
  });

  it("does not record a call across one, in either direction", () => {
    // The edge that would leak: a principal who can read only platform asking "who calls
    // withRetry" must not learn that issueRefund exists.
    expect(graph.callersOf({ path: "platform/retry.ts", name: "withRetry" })).toEqual([]);
    expect(graph.calleesOf({ path: "payments/refunds.ts", name: "issueRefund" })).toEqual([
      { path: "payments/refunds.ts", name: "record" },
    ]);
  });

  it("counts what it dropped, so the gap is a number rather than a comment", () => {
    expect(graph.crossRepositoryCalls).toBe(1);
  });
});

/* ---------------------------------------------------------------- the assistant, end to end */

describe("the assistant over the fixture repositories", async () => {
  const assistant = await createAssistant({
    repositoryRoot: join(FIXTURES, "repos"),
    aclManifest: join(FIXTURES, "acl.json"),
    groupMap: join(FIXTURES, "groups.json"),
  });

  it("cites line ranges in a version, not file names", async () => {
    const result = await assistant.ask("prn_dev", "how is the retry backoff delay computed");

    expect(result.citations.length).toBeGreaterThan(0);
    for (const citation of result.citations) {
      expect(citation.rendered).toMatch(/^platform\/[a-z]+\.ts:\d+(-\d+)?$/);
      expect(citation.version).toMatch(/^sv_[0-9a-f]{64}$/);
    }
  });

  it("never gives a platform-only principal a payments citation", async () => {
    // Several questions whose best answer is in payments. The platform's pre-filter is what keeps
    // those chunks out of the candidate set; this asserts it holds for code as it does for prose.
    for (const query of [
      "how is the refund window checked",
      "how is the refund reserve rate calculated",
      "what happens when a refund is outside the window",
      "issueRefund withinWindow REFUND_WINDOW_DAYS",
    ]) {
      const result = await assistant.ask("prn_dev", query);
      for (const citation of result.citations) {
        expect(citation.path, query).not.toMatch(/^payments\//);
      }
    }
  });

  it("never lists a related symbol from another repository", async () => {
    const result = await assistant.ask("prn_dev", "withRetry retry operation attempts");
    for (const entry of result.related) {
      for (const ref of [...entry.callers, ...entry.callees]) {
        expect(ref.path).toMatch(/^platform\//);
      }
    }
  });

  it("drops the cross-repository calls the fixture really makes", () => {
    // issueRefund calls withRetry and postJson, both in platform.
    expect(assistant.graph.crossRepositoryCalls).toBe(2);
  });

  it("evaluates with evalkit's own metrics against symbol-keyed labels", async () => {
    const dataset = loadCodebaseDataset(join(FIXTURES, "dataset.json"));
    const scores = await evaluate(dataset, assistant, assistant.ranked);

    // Not asserting the values: they measure a stand-in embedder, and a test that pinned them
    // would turn a number nobody should quote into one the suite defends.
    expect(scores.items).toBe(5);
    expect(scores.unscorable).toEqual(["p-dev-003"]);
    expect(scores.recallAt5).toBeGreaterThanOrEqual(0);
    expect(scores.recallAt5).toBeLessThanOrEqual(1);
  });

  it("refuses a label naming a symbol that no longer exists", async () => {
    const chunks = await assistant.chunks();
    expect(() =>
      chunksForSymbol(
        { path: "platform/retry.ts", symbol: "renamedAway", grade: 3 },
        chunks,
        assistant.versionOf,
      ),
    ).toThrow(/no chunk carries that symbol/);
  });
});
