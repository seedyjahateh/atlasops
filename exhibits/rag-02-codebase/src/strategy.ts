/**
 * One chunk per top-level symbol.
 *
 * This is the exhibit's one real addition to the chunking layer, and it is **not** a change to
 * `packages/ingest`. `ChunkStrategy` is an interface — `{ name, chunk(text, counter) }` — so a
 * strategy for code can be supplied from here without widening anything. That is the reuse claim
 * the layered structure was built on, meeting its first real consumer: an exhibit that needed a
 * different chunker got one without asking the package to learn about TypeScript.
 *
 * **Why not the structure-aware Markdown chunker.** It parses headings and paragraphs. Code has
 * neither, so every file would fall through to the line splitter and a chunk boundary would land
 * wherever the token budget ran out — in the middle of a function, splitting its signature from its
 * body. A citation into that chunk points at half a definition.
 *
 * **An oversized symbol is cut between lines, never within one**, and every piece keeps the symbol's
 * name as its heading path. A class longer than the budget produces several chunks that all say
 * which class they are part of, rather than one chunk the model cannot fit or several it cannot
 * place.
 */

import type { ChunkDraft, ChunkStrategy, TokenCounter } from "@atlasops/ingest";

import { topLevelSymbols, type CodeSymbol } from "./symbols.js";

export interface SymbolAwareOptions {
  readonly maxTokens: number;
}

/** Line boundaries inside `[start, end)`: the offset just after each newline. */
function lineStarts(text: string, start: number, end: number): number[] {
  const starts = [start];
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\n" && index + 1 < end) starts.push(index + 1);
  }
  return starts;
}

function trimmed(text: string, start: number, end: number): { start: number; end: number } | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/.test(text[to - 1] ?? "")) to -= 1;
  return from < to ? { start: from, end: to } : null;
}

function draft(
  text: string,
  start: number,
  end: number,
  path: readonly string[],
  counter: TokenCounter,
): ChunkDraft | null {
  const range = trimmed(text, start, end);
  if (range === null) return null;
  const slice = text.slice(range.start, range.end);
  return {
    text: slice,
    charStart: range.start,
    charEnd: range.end,
    headingPath: path,
    tokenCount: counter(slice),
  };
}

/** Packs whole lines into pieces within budget. A single line over budget is kept whole. */
function splitByLines(
  text: string,
  symbol: CodeSymbol,
  path: readonly string[],
  maxTokens: number,
  counter: TokenCounter,
): ChunkDraft[] {
  const starts = lineStarts(text, symbol.charStart, symbol.charEnd);
  const pieces: ChunkDraft[] = [];

  let pieceStart = symbol.charStart;
  let tokens = 0;

  for (let index = 0; index < starts.length; index += 1) {
    const lineStart = starts[index] ?? symbol.charEnd;
    const lineEnd = starts[index + 1] ?? symbol.charEnd;
    const lineTokens = counter(text.slice(lineStart, lineEnd));

    // A line is never divided. Over budget on its own, it becomes an oversized piece — a visible
    // problem, rather than a mangled one that cuts an expression in two.
    if (tokens > 0 && tokens + lineTokens > maxTokens) {
      const piece = draft(text, pieceStart, lineStart, path, counter);
      if (piece !== null) pieces.push(piece);
      pieceStart = lineStart;
      tokens = 0;
    }
    tokens += lineTokens;
  }

  const last = draft(text, pieceStart, symbol.charEnd, path, counter);
  if (last !== null) pieces.push(last);
  return pieces;
}

export function headingFor(symbol: CodeSymbol): string {
  return `${symbol.kind} ${symbol.name}`;
}

export function symbolAware(options: SymbolAwareOptions): ChunkStrategy {
  const { maxTokens } = options;

  return {
    name: `symbol-aware(max=${String(maxTokens)})`,

    chunk: (text: string, counter: TokenCounter): readonly ChunkDraft[] => {
      const drafts: ChunkDraft[] = [];
      const seen = new Set<string>();
      // Parsed once. Parsing per symbol would make chunking quadratic in the number of
      // declarations, which is the kind of cost nobody notices until a generated file arrives.
      const symbols = topLevelSymbols("source.ts", text);

      for (const symbol of symbols) {
        // Several names from one `const a = …, b = …` statement share a range. They become one
        // chunk named after every name in it, not several identical chunks.
        const key = `${String(symbol.charStart)}:${String(symbol.charEnd)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const sharing = symbols.filter(
          (other) => other.charStart === symbol.charStart && other.charEnd === symbol.charEnd,
        );
        const path = sharing.map(headingFor);

        const whole = draft(text, symbol.charStart, symbol.charEnd, path, counter);
        if (whole === null) continue;

        if (whole.tokenCount <= maxTokens) drafts.push(whole);
        else drafts.push(...splitByLines(text, symbol, path, maxTokens, counter));
      }

      return drafts;
    },
  };
}
