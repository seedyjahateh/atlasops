/**
 * The Markdown parser (PRD 4.3).
 *
 * Hand-written and line-based rather than delegated to a Markdown library, for the same reason
 * `contracts` owns its validators: this package sits under everything that retrieves, and the thing
 * it needs from a parser is not rendering but **faithful character offsets**. Most Markdown
 * libraries produce an AST for rendering; positions are secondary, sometimes approximate across
 * inline constructs, and normalising whitespace on the way through is considered a feature. Here an
 * offset that is off by two is a citation that points at the wrong words.
 *
 * What it recognises is exactly PRD 4.3's list and nothing more: headings, paragraphs, list groups,
 * table blocks, fenced code blocks. Inline syntax — emphasis, links, inline code — is deliberately
 * not parsed. It does not change where a chunk may be cut, and every construct parsed is a
 * construct that can be parsed wrongly.
 *
 * An unterminated code fence runs to the end of the document rather than being reinterpreted as
 * prose. That is the conservative reading: treating the rest of the file as headings and paragraphs
 * would let a `#` inside an unclosed example open a section that the author never wrote, and the
 * chunker would then cut a boundary in the middle of somebody's code sample.
 */

import type { Block, BlockKind, DocumentNode, Heading } from "./document.js";

interface Line {
  /** With any trailing carriage return removed, so matching is not line-ending dependent. */
  readonly text: string;
  readonly start: number;
  /** Exclusive, and excluding the line terminator. */
  readonly end: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const LIST_ITEM = /^[ \t]{0,3}([-*+]|\d{1,9}[.)])[ \t]+/;
const TABLE_ROW = /^[ \t]{0,3}\|/;

function linesOf(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;

  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") continue;
    const raw = text.slice(start, index);
    const trimmed = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ text: trimmed, start, end: start + trimmed.length });
    start = index + 1;
  }

  return lines;
}

function isBlank(line: Line): boolean {
  return line.text.trim().length === 0;
}

/** True for any line that ends the paragraph it would otherwise continue. */
function startsSomethingElse(line: Line): boolean {
  return (
    HEADING.test(line.text) ||
    FENCE.test(line.text) ||
    TABLE_ROW.test(line.text) ||
    LIST_ITEM.test(line.text)
  );
}

interface Building {
  readonly heading: Heading | null;
  readonly blocks: Block[];
  readonly children: Building[];
  readonly charStart: number;
  charEnd: number;
}

function freeze(node: Building): DocumentNode {
  const children = node.children.map(freeze);
  const ends = [
    node.charEnd,
    ...node.blocks.map((block) => block.charEnd),
    ...children.map((child) => child.charEnd),
  ];

  return {
    heading: node.heading,
    blocks: [...node.blocks],
    children,
    charStart: node.charStart,
    charEnd: Math.max(...ends),
  };
}

/**
 * Consume a run of lines into one block.
 *
 * Returns the index to resume from, so every branch advances and the scanner cannot stall — the one
 * failure mode a hand-written line scanner really has.
 */
function readBlock(
  lines: readonly Line[],
  from: number,
): { readonly block: Block; readonly next: number } {
  const first = lines[from];
  if (first === undefined) throw new Error("readBlock called past the end of the document");

  const fence = FENCE.exec(first.text);
  if (fence !== null) {
    const marker = fence[1] ?? "```";
    let index = from + 1;
    // `last` tracks the last line with content on it, so an unterminated fence ends at the last
    // real line of the document rather than at the blank one after it. Blank lines *inside* the
    // fence are still part of the block — they are somebody's code.
    let last = first;
    while (index < lines.length) {
      const line = lines[index];
      index += 1;
      if (line === undefined) break;
      if (!isBlank(line)) last = line;
      if (line.text.trimStart().startsWith(marker)) break;
    }
    return { block: block("code", first, last), next: index };
  }

  const kind: BlockKind = TABLE_ROW.test(first.text)
    ? "table"
    : LIST_ITEM.test(first.text)
      ? "list"
      : "paragraph";

  let index = from + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || isBlank(line)) break;

    if (kind === "table" && !TABLE_ROW.test(line.text)) break;
    // A list continues through its own items and through indented continuation lines, which is
    // what keeps a multi-paragraph list item inside one block.
    if (kind === "list" && !LIST_ITEM.test(line.text) && !/^[ \t]/.test(line.text)) break;
    if (kind === "paragraph" && startsSomethingElse(line)) break;

    index += 1;
  }

  return { block: block(kind, first, lines[index - 1] ?? first), next: index };
}

function block(kind: BlockKind, first: Line, last: Line): Block {
  return { kind, charStart: first.start, charEnd: last.end };
}

export function parseDocument(text: string): DocumentNode {
  const lines = linesOf(text);
  const root: Building = {
    heading: null,
    blocks: [],
    children: [],
    charStart: 0,
    charEnd: 0,
  };
  const stack: Building[] = [root];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || isBlank(line)) {
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line.text);
    if (heading !== null) {
      const depth = (heading[1] ?? "#").length;
      while (stack.length > 1) {
        const top = stack[stack.length - 1];
        if (top === undefined) break;
        if (top.heading !== null && top.heading.depth < depth) break;
        stack.pop();
      }

      const section: Building = {
        heading: { text: heading[2] ?? "", depth },
        blocks: [],
        children: [],
        charStart: line.start,
        charEnd: line.end,
      };
      stack[stack.length - 1]?.children.push(section);
      stack.push(section);
      index += 1;
      continue;
    }

    const read = readBlock(lines, index);
    stack[stack.length - 1]?.blocks.push(read.block);
    index = read.next;
  }

  return freeze(root);
}
