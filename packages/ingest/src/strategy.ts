/**
 * Chunking strategies (PRD 4.3).
 *
 * **Structure-aware is the default and fixed-width is the fallback, and both are values rather than
 * settings.** PRD 4.3 rejects fixed-width sliding windows as the default because they split tables
 * and code mid-row, and because the overlap that repairs that inflates the index and creates
 * near-duplicate candidates which distort fusion. It keeps them available "for sources with no
 * recoverable structure, selected per connector rather than globally" — so the strategy is an
 * argument a caller passes, not a module-level constant a connector has to fight. Two sources in
 * one run can be chunked differently, and the tests demonstrate exactly that.
 *
 * Semantic boundary detection is deliberately absent. PRD 4.3 assigns it to RAG-09, and adopting it
 * here without measurement would be the unevidenced choice this whole project exists to avoid.
 */

import {
  boundaryKey,
  commonPrefix,
  flatten,
  headingText,
  type BlockKind,
  type Heading,
} from "./document.js";
import { parseDocument } from "./markdown.js";
import {
  bySentence,
  byLine,
  byWhitespace,
  byWidth,
  sliceOf,
  splitToBudget,
  trimRange,
  type Range,
  type Segmenter,
} from "./ranges.js";
import type { TokenCounter } from "./tokens.js";

export interface ChunkDraft {
  /** Always `source.slice(charStart, charEnd)`. */
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly headingPath: readonly string[];
  /** The counter applied to this exact slice, not the estimate packing used. */
  readonly tokenCount: number;
}

export interface ChunkStrategy {
  /** Recorded so an evaluation run can say which strategy produced a chunk set. */
  readonly name: string;
  readonly chunk: (text: string, counter: TokenCounter) => readonly ChunkDraft[];
}

/**
 * The backstop width, in characters, under every structural segmenter.
 *
 * Tied to the same four-characters-per-token ratio the default counter uses. It is only ever
 * reached by a single unbroken run of non-whitespace longer than the budget, and it is the one
 * place a cut can land inside a word.
 */
function backstopWidth(maxTokens: number): number {
  return Math.max(1, maxTokens * 4);
}

function levelsFor(kind: BlockKind, maxTokens: number): readonly Segmenter[] {
  // A table or a code block is cut between lines, never within one: PRD 4.3's whole objection to
  // fixed-width windows is that they split rows. Prose has no rows, so it is cut between sentences.
  const structural: Segmenter = kind === "paragraph" ? bySentence : byLine;
  return [structural, byWhitespace, byWidth(backstopWidth(maxTokens))];
}

function draftOf(
  text: string,
  range: Range,
  path: readonly Heading[],
  counter: TokenCounter,
): ChunkDraft | null {
  const trimmed = trimRange(text, range);
  if (trimmed === null) return null;

  const slice = sliceOf(text, trimmed);
  return {
    text: slice,
    charStart: trimmed.start,
    charEnd: trimmed.end,
    headingPath: headingText(path),
    tokenCount: counter(slice),
  };
}

export interface StructureAwareOptions {
  readonly maxTokens: number;
  /**
   * The shallowest heading level a chunk may not be packed across.
   *
   * `2` means blocks under two different `##` sections never share a chunk, while blocks under
   * different `###` subsections of the same `##` may. Set it to 6 and every heading is a hard
   * boundary; set it to 0 and headings stop constraining packing altogether.
   */
  readonly boundaryDepth: number;
}

export function structureAware(options: StructureAwareOptions): ChunkStrategy {
  const { maxTokens, boundaryDepth } = options;

  return {
    name: `structure-aware(max=${String(maxTokens)},depth=${String(boundaryDepth)})`,

    chunk: (text: string, counter: TokenCounter): readonly ChunkDraft[] => {
      const placed = flatten(parseDocument(text));
      const drafts: ChunkDraft[] = [];

      let open: { start: number; end: number; path: readonly Heading[] } | null = null;
      let openKey = "";
      let tokens = 0;

      const flush = (): void => {
        if (open === null) return;
        const draft = draftOf(text, { start: open.start, end: open.end }, open.path, counter);
        if (draft !== null) drafts.push(draft);
        open = null;
        tokens = 0;
      };

      for (const entry of placed) {
        const { block, headingPath } = entry;
        const key = boundaryKey(headingPath, boundaryDepth);
        const blockTokens = counter(text.slice(block.charStart, block.charEnd));

        // A block that does not fit on its own is split within itself, keeping its heading path.
        // Packing it with a neighbour first would only make the oversized piece larger.
        if (blockTokens > maxTokens) {
          flush();
          const pieces = splitToBudget(
            text,
            { start: block.charStart, end: block.charEnd },
            levelsFor(block.kind, maxTokens),
            maxTokens,
            counter,
          );
          for (const piece of pieces) {
            const draft = draftOf(text, piece, headingPath, counter);
            if (draft !== null) drafts.push(draft);
          }
          continue;
        }

        if (open === null || key !== openKey) {
          flush();
          open = { start: block.charStart, end: block.charEnd, path: headingPath };
          openKey = key;
          tokens = blockTokens;
          continue;
        }

        // The gap between blocks — blank lines, and any deeper heading between them — is part of
        // the slice, so it is part of what the chunk costs.
        const added = counter(text.slice(open.end, block.charEnd));
        if (tokens + added > maxTokens) {
          flush();
          open = { start: block.charStart, end: block.charEnd, path: headingPath };
          openKey = key;
          tokens = blockTokens;
          continue;
        }

        open = {
          start: open.start,
          end: block.charEnd,
          path: commonPrefix(open.path, headingPath),
        };
        tokens += added;
      }

      flush();
      return drafts;
    },
  };
}

export interface FixedWidthOptions {
  readonly maxTokens: number;
  /**
   * How much of the previous window to repeat.
   *
   * Zero unless a connector has a reason. PRD 4.3 names the cost directly: overlap inflates the
   * index and produces near-duplicate candidates that distort fusion, so it buys recall at a
   * ranking layer's expense and should be a decision somebody made for a named source.
   */
  readonly overlapTokens: number;
}

/**
 * The fallback for sources with no recoverable structure.
 *
 * It reads no headings and emits an empty heading path, which is the honest answer for a source
 * whose structure could not be recovered — inventing a location for a passage would put a
 * fabricated breadcrumb into every citation rendered from it.
 */
export function fixedWidth(options: FixedWidthOptions): ChunkStrategy {
  const { maxTokens, overlapTokens } = options;

  return {
    name: `fixed-width(max=${String(maxTokens)},overlap=${String(overlapTokens)})`,

    chunk: (text: string, counter: TokenCounter): readonly ChunkDraft[] => {
      const words = byWhitespace(text, { start: 0, end: text.length });
      const drafts: ChunkDraft[] = [];

      let from = 0;
      while (from < words.length) {
        const first = words[from];
        if (first === undefined) break;

        let end = from;
        let tokens = 0;
        let cursor = first.start;
        while (end < words.length) {
          const word = words[end];
          if (word === undefined) break;
          const added = counter(text.slice(cursor, word.end));
          // The first word is taken whatever it costs, so a single word longer than the budget
          // produces one oversized chunk rather than an empty window and a stalled loop.
          if (end > from && tokens + added > maxTokens) break;
          tokens += added;
          cursor = word.end;
          end += 1;
        }

        const last = words[end - 1];
        if (last === undefined) break;

        const draft = draftOf(text, { start: first.start, end: last.end }, [], counter);
        if (draft !== null) drafts.push(draft);
        if (end >= words.length) break;

        // Overlap is taken by starting the next window earlier in the same text, so the repeated
        // passage is a real prefix of that window rather than a copy spliced in — every chunk
        // stays one contiguous slice of the source. `from + 1` is the floor, so the loop advances.
        let back = end;
        let repeated = 0;
        while (overlapTokens > 0 && back > from + 1 && repeated < overlapTokens) {
          back -= 1;
          const word = words[back];
          if (word === undefined) break;
          repeated += counter(sliceOf(text, word));
        }

        from = back;
      }

      return drafts;
    },
  };
}
