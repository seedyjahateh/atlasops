/**
 * The public surface of `@atlasops/ingest`, at P6a.
 *
 * Layer 4. This phase is parsing and chunking only: pure functions over text, with a token counter
 * as the single injected port. It imports `@atlasops/contracts` and nothing else — the connectors,
 * the corpus wiring, the embedding reuse and the deletion propagation arrive in P6b, and each will
 * bring its dependency with it rather than being declared ahead of the code that needs it.
 *
 * The boundary this package will be tested against hardest is the one above it: `ingest` may never
 * import `retrieval`, `grounding` or `evalkit`. The checker enforces it; nothing here asserts it.
 */

export {
  boundaryKey,
  commonPrefix,
  flatten,
  headingText,
  type Block,
  type BlockKind,
  type DocumentNode,
  type Heading,
  type PlacedBlock,
} from "./document.js";

export { parseDocument } from "./markdown.js";

export { approximateTokenCounter, type TokenCounter } from "./tokens.js";

export {
  byLine,
  bySentence,
  byWhitespace,
  byWidth,
  pack,
  sliceOf,
  splitToBudget,
  trimRange,
  type Range,
  type Segmenter,
} from "./ranges.js";

export {
  fixedWidth,
  structureAware,
  type ChunkDraft,
  type ChunkStrategy,
  type FixedWidthOptions,
  type StructureAwareOptions,
} from "./strategy.js";

export { chunksFor, textOf, type ChunkingInput } from "./assemble.js";
