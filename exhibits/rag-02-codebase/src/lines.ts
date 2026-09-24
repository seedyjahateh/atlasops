/**
 * Citations as line ranges, pinned to the version they were cut from.
 *
 * RAG-02's summary asks for "line-level citations", and the acceptance for this exhibit adds the
 * part that makes them worth having: they resolve to line ranges **in a source version**, not to a
 * file name. A citation of `payments/refunds.ts` is a pointer to a file that may have changed since;
 * `payments/refunds.ts:31-43 @ ver_…` is a pointer to exact bytes, and the version identifier is
 * what lets anybody check it.
 *
 * **Lines are computed from the version's own bytes, and the bytes are checked first.** The text is
 * hashed and compared with the reference's version identifier before a single line is counted. A
 * line range computed against the file as it is today, for a citation made against the file as it
 * was, would point at plausible, wrong code — and nothing about a wrong line number looks wrong.
 */

import { contentHashOf, formatSourceVersionId, type SourceVersionId } from "@atlasops/contracts";

export interface LineRange {
  /** One-based, inclusive, the way every editor numbers lines. */
  readonly startLine: number;
  readonly endLine: number;
}

/** The one-based line containing the character at `offset`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * The lines a character range covers.
 *
 * `charEnd` is exclusive, so a range ending exactly after a newline ends on the line before it —
 * otherwise every citation of a whole declaration would claim the blank line after it.
 */
export function lineRangeOf(text: string, charStart: number, charEnd: number): LineRange {
  if (charStart < 0 || charEnd > text.length || charEnd < charStart) {
    throw new RangeError(
      `[${String(charStart)}, ${String(charEnd)}) is not a range within a ${String(text.length)}-character text`,
    );
  }
  const last = charEnd > charStart ? charEnd - 1 : charStart;
  return { startLine: lineAt(text, charStart), endLine: lineAt(text, last) };
}

export class VersionMismatch extends Error {
  public override readonly name = "VersionMismatch";
}

/**
 * Resolves a range against the exact bytes of a source version, or refuses.
 *
 * The refusal is the feature. Line numbers computed against bytes that are not the cited version's
 * are wrong in a way nothing downstream can detect.
 */
export function linesInVersion(
  text: string,
  version: SourceVersionId,
  charStart: number,
  charEnd: number,
): LineRange {
  const actual = formatSourceVersionId(contentHashOf(text));
  if (actual !== version) {
    throw new VersionMismatch(
      `the text supplied is version ${actual}, and the citation is against ${version}. Line numbers ` +
        `computed against different bytes point at plausible, wrong code, so none are returned.`,
    );
  }
  return lineRangeOf(text, charStart, charEnd);
}

/** `payments/refunds.ts:31-43` — the form every editor and every code host understands. */
export function renderLines(path: string, range: LineRange): string {
  return range.startLine === range.endLine
    ? `${path}:${String(range.startLine)}`
    : `${path}:${String(range.startLine)}-${String(range.endLine)}`;
}
