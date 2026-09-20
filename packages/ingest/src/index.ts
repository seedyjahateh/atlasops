/**
 * The public surface of `@atlasops/ingest`.
 *
 * Layer 4. It imports `contracts`, `telemetry`, `corpus`, `model-gateway` and `governance` — every
 * dependency its row in PRD 11.2 allows, and each one arrived with the code that needed it rather
 * than being declared ahead of it.
 *
 * The boundary that matters is the one above: `ingest` may never import `retrieval`, `grounding` or
 * `evalkit`. The checker enforces it; nothing here asserts it.
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

export type { Connector, FetchedSource } from "./connector.js";

export {
  fixtureConnector,
  type FixtureConnector,
  type FixtureConnectorOptions,
  type FixtureSource,
} from "./fixture-connector.js";

export { failingChunkSink, inMemoryChunkSink, type ChunkSink, type StoredChunk } from "./sink.js";

export {
  ingest,
  probeRemoved,
  versionsOf,
  type Disposition,
  type IngestionReport,
  type IngestionRun,
  type SourceOutcome,
} from "./pipeline.js";

export {
  INGESTION_BUDGETS,
  assertWithinIngestionBudget,
  checkIngestionBudget,
  ingestionBudgetById,
  ingestionCostPer1kChunks,
  ingestionProfile,
  type IngestionBudget,
  type IngestionBudgetId,
  type IngestionBudgetResult,
  type IngestionProfileInput,
} from "./budgets.js";
