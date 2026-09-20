/**
 * Offset arithmetic: segmenting, packing, and splitting to a budget.
 *
 * Everything here works on half-open `[start, end)` ranges into one string and never on extracted
 * substrings, so a chunk stays a contiguous slice of its source version all the way through — see
 * the header of `document.ts` for why that matters.
 *
 * Two properties every segmenter holds, and which the tests check rather than assume:
 *
 * **Segments are contiguous and cover the whole range.** A separator belongs to the segment before
 * it, so no character falls between two segments. A segmenter that dropped the whitespace it cut on
 * would leave gaps, and a chunk assembled from those segments would no longer be a slice.
 *
 * **Packing counts additively.** The cost of adding a segment is the counter applied to the text
 * between the current end and the new end, not the counter applied to the whole candidate slice.
 * Re-counting the candidate each time is quadratic in document length, and on a long source that is
 * the difference between an ingestion run and an ingestion incident. A real tokenizer is not exactly
 * additive across a boundary, so the packed size is an estimate — which is why the size a chunk
 * finally reports is one counter call on the finished slice.
 */

import type { TokenCounter } from "./tokens.js";

export interface Range {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

export type Segmenter = (text: string, range: Range) => readonly Range[];

export function sliceOf(text: string, range: Range): string {
  return text.slice(range.start, range.end);
}

/** The same range with leading and trailing whitespace excluded, or null if nothing is left. */
export function trimRange(text: string, range: Range): Range | null {
  let start = range.start;
  let end = range.end;
  while (start < end && /\s/.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  return end > start ? { start, end } : null;
}

function cutAt(range: Range, boundaries: readonly number[]): readonly Range[] {
  const ranges: Range[] = [];
  let start = range.start;
  for (const boundary of boundaries) {
    if (boundary <= start || boundary >= range.end) continue;
    ranges.push({ start, end: boundary });
    start = boundary;
  }
  if (start < range.end) ranges.push({ start, end: range.end });
  return ranges;
}

/** One segment per line. Rows of a table and lines of a code block are never cut within. */
export const byLine: Segmenter = (text, range) => {
  const boundaries: number[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    if (text[index] === "\n") boundaries.push(index + 1);
  }
  return cutAt(range, boundaries);
};

/** One segment per sentence, for prose that is a single paragraph longer than the budget. */
export const bySentence: Segmenter = (text, range) => {
  const boundaries: number[] = [];
  for (let index = range.start; index < range.end - 1; index += 1) {
    const character = text[index];
    if (character !== "." && character !== "!" && character !== "?") continue;
    let after = index + 1;
    while (after < range.end && /\s/.test(text[after] ?? "")) after += 1;
    if (after > index + 1) boundaries.push(after);
  }
  return cutAt(range, boundaries);
};

/** One segment per whitespace-delimited word. The finest cut that never lands inside a word. */
export const byWhitespace: Segmenter = (text, range) => {
  const boundaries: number[] = [];
  let inWhitespace = false;
  for (let index = range.start; index < range.end; index += 1) {
    const whitespace = /\s/.test(text[index] ?? "");
    if (inWhitespace && !whitespace) boundaries.push(index);
    inWhitespace = whitespace;
  }
  return cutAt(range, boundaries);
};

/**
 * Fixed-character cuts, used only as the backstop under every other segmenter.
 *
 * It is the one segmenter that will cut inside a word, and it exists so that a single unbroken run
 * — a base64 blob, a minified line, a language that does not space its words — still terminates
 * rather than producing one chunk that no model will accept.
 */
export function byWidth(width: number): Segmenter {
  return (_text, range) => {
    const boundaries: number[] = [];
    for (let at = range.start + width; at < range.end; at += width) boundaries.push(at);
    return cutAt(range, boundaries);
  };
}

/** Greedily merge adjacent segments while they fit. See the file header on additive counting. */
export function pack(
  text: string,
  ranges: readonly Range[],
  maxTokens: number,
  counter: TokenCounter,
): readonly Range[] {
  const packed: Range[] = [];
  let current: Range | null = null;
  let tokens = 0;

  for (const range of ranges) {
    if (current === null) {
      current = range;
      tokens = counter(sliceOf(text, range));
      continue;
    }

    const added = counter(text.slice(current.end, range.end));
    if (tokens + added > maxTokens) {
      packed.push(current);
      current = range;
      tokens = counter(sliceOf(text, range));
      continue;
    }

    current = { start: current.start, end: range.end };
    tokens += added;
  }

  if (current !== null) packed.push(current);
  return packed;
}

/**
 * Cut a range down to the budget, trying each segmenter in turn.
 *
 * The order is what keeps PRD 4.3's promise that a table or a code block is not split mid-row: the
 * coarsest cut that respects the structure is tried first, and a finer one is only reached for a
 * segment that is still over budget on its own. A range that no segmenter can divide is returned
 * whole rather than mangled — the caller sees an oversized chunk, which is a visible problem,
 * instead of a silently corrupted one.
 */
export function splitToBudget(
  text: string,
  range: Range,
  levels: readonly Segmenter[],
  maxTokens: number,
  counter: TokenCounter,
): readonly Range[] {
  if (counter(sliceOf(text, range)) <= maxTokens) return [range];

  const [level, ...rest] = levels;
  if (level === undefined) return [range];

  const segments = level(text, range);
  if (segments.length <= 1) return splitToBudget(text, range, rest, maxTokens, counter);

  return pack(text, segments, maxTokens, counter).flatMap((piece) =>
    piece.start === range.start && piece.end === range.end
      ? splitToBudget(text, piece, rest, maxTokens, counter)
      : splitToBudget(text, piece, levels, maxTokens, counter),
  );
}
