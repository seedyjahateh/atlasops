/**
 * The document tree (PRD 4.3).
 *
 * The parser emits headings, paragraphs, list groups, table blocks and code blocks — the five kinds
 * PRD 4.3 names — and the chunker packs siblings from it. Everything here is expressed as **offsets
 * into the source text rather than extracted strings**, and that is the load-bearing decision in
 * this file.
 *
 * A chunk has to be a contiguous slice of the source version it belongs to. PRD 4.4 requires every
 * chunk to carry character offsets, and PRD 7.2's verification pass checks a citation against the
 * passage it names. If the parser rebuilt text — normalising whitespace, re-joining lines,
 * re-emitting a heading above the block it introduced — those offsets would point at something that
 * is nearly but not exactly what was cited, and a verification pass that is nearly right is worse
 * than none, because it produces confident agreement about the wrong span.
 *
 * So no node here holds text. `text.slice(charStart, charEnd)` is the content, always.
 */

export type BlockKind = "paragraph" | "list" | "table" | "code";

export interface Block {
  readonly kind: BlockKind;
  readonly charStart: number;
  /** Exclusive. `text.slice(charStart, charEnd)` is the block. */
  readonly charEnd: number;
}

export interface Heading {
  readonly text: string;
  /** 1 for a top-level heading. The chunker's boundary depth is compared against this. */
  readonly depth: number;
}

export interface DocumentNode {
  /** Null at the root, which is the document before any heading. */
  readonly heading: Heading | null;
  /** This section's own blocks, in document order, before any subsection. */
  readonly blocks: readonly Block[];
  readonly children: readonly DocumentNode[];
  readonly charStart: number;
  readonly charEnd: number;
}

/** A block with the headings above it, root first. */
export interface PlacedBlock {
  readonly block: Block;
  readonly headingPath: readonly Heading[];
}

/**
 * Every block in document order, each carrying its heading path.
 *
 * A section's own blocks come before its subsections', which is document order because the parser
 * only opens a child once it meets that child's heading.
 */
export function flatten(node: DocumentNode, path: readonly Heading[] = []): readonly PlacedBlock[] {
  const here = node.heading === null ? path : [...path, node.heading];
  return [
    ...node.blocks.map((block) => ({ block, headingPath: here })),
    ...node.children.flatMap((child) => flatten(child, here)),
  ];
}

/** The heading path as the strings PRD 4.4 asks a chunk to carry. */
export function headingText(path: readonly Heading[]): readonly string[] {
  return path.map((heading) => heading.text);
}

/**
 * The headings a chunk may not be packed across.
 *
 * PRD 4.3 permits packing siblings "without crossing a heading boundary above a configured depth",
 * so two blocks may share a chunk only when the headings at or above that depth are identical.
 * Deeper headings are free to differ — that is the whole point of the setting, and it is why the
 * chunk's own heading path ends up being the common prefix of its members'.
 */
export function boundaryKey(path: readonly Heading[], boundaryDepth: number): string {
  return path
    .filter((heading) => heading.depth <= boundaryDepth)
    .map((heading) => `${String(heading.depth)}:${heading.text}`)
    .join("\u001f");
}

/** The longest shared prefix of two heading paths. */
export function commonPrefix(a: readonly Heading[], b: readonly Heading[]): readonly Heading[] {
  const shared: Heading[] = [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) break;
    if (left.depth !== right.depth || left.text !== right.text) break;
    shared.push(left);
  }
  return shared;
}
