/**
 * The public surface of `@atlasops/composition`.
 *
 * Layer 8, between `evalkit` and the applications (ADR 0005). It may import every package below it,
 * which is exactly why it should contain as little as possible: a package permitted to touch
 * everything is an inviting home for anything two applications happen to share, and the first
 * helper that lands here for convenience rather than necessity starts the decay PRD 11.2 warns
 * about.
 *
 * What it owns is assembly. There is no transport here, no configuration parsing, no process
 * lifecycle, and nothing that opens a connection or reads an environment variable — those are the
 * applications' job, and a composition root that did them would be an application other
 * applications import.
 *
 * The reason it exists at all: `createAnswerPipeline` returns one object that the API serves and
 * the evaluation runner measures, so a change to a default cannot reach one without reaching the
 * other.
 */

export type { AnswerPorts, CorePorts, IngestionPorts } from "./ports.js";

export {
  createAnswerPipeline,
  type AnswerOutcome,
  type AnswerPipeline,
  type AnswerPipelineOptions,
  type AnswerRequest,
} from "./answering.js";

export {
  createIngestionPipeline,
  type IngestionPipeline,
  type IngestionPipelineOptions,
} from "./ingesting.js";

export { indexingChunkSink } from "./chunk-sink.js";

export { corpusVersionOracle } from "./corpus-oracle.js";
