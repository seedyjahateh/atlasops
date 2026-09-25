/**
 * Which models a run uses, chosen by name.
 *
 * Evidence is produced in two places — the evaluation runner and the load run — and both need the
 * same answer to "stand-ins, or the real adapter?". The OpenAI half lives here because this is the
 * one module a provider may enter; the stand-in *generator* does not, because it emits PRD 7.1's
 * answer structure and so lives in `grounding`, above this layer. A caller therefore takes the
 * embedder, generator and price table from here when the choice is `openai`, and its own stand-ins
 * otherwise.
 *
 * **The stand-ins are the default, and the real set must be asked for by name.** A command that
 * spends money should never do so because somebody forgot a flag. The OpenAI set refuses to
 * construct without `OPENAI_API_KEY`, naming the variable, and never echoes any part of a key.
 *
 * **The reranker is not part of either set.** OpenAI publishes no first-party rerank model (ADR
 * 0006), so every run keeps the stand-in reranker and records it as unselected. Filling the field
 * with an invented identifier would be worse than the gap.
 */

import type { EmbeddingModelRef } from "@atlasops/contracts";
import type { PriceTable } from "@atlasops/telemetry";

import { openAiEmbedder, openAiGenerator, openAiKeyFromEnv } from "./openai.js";
import type { Embedder, Generator } from "./ports.js";
import {
  OPENAI_DEFAULT_EMBEDDING_DIMENSION,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  OPENAI_DEFAULT_GENERATION_MODEL,
  OPENAI_PRICE_TABLE,
} from "./prices-openai.js";
import type { HttpTransport } from "./transport.js";

export const MODEL_CHOICES = ["stand-in", "openai"] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

/** Recorded wherever a run names its reranker, so the gap is on the artefact rather than implied. */
export const UNSELECTED_RERANKER =
  "stand-in-reranker (unselected: no provider rerank model, ADR 0006)";

export function parseModelChoice(value: string | undefined): ModelChoice {
  if (value === undefined || value.length === 0) return "stand-in";
  if ((MODEL_CHOICES as readonly string[]).includes(value)) return value as ModelChoice;
  throw new Error(
    `"${value}" is not a model set this build has. Installed: ${MODEL_CHOICES.join(", ")}. The ` +
      `default is stand-in, so nothing spends money unless it is asked to.`,
  );
}

export interface ProviderModelSet {
  readonly embedder: Embedder;
  readonly embedding: EmbeddingModelRef;
  readonly generator: Generator;
  readonly prices: PriceTable;
  /** Model identifiers by role, as PRD 12 item 2 requires an artefact to record them. */
  readonly identifiers: Readonly<Record<string, string>>;
}

export interface OpenAiModelSetOptions {
  readonly embeddingModel?: string;
  readonly generationModel?: string;
  /** Tests pass a recording transport. The default is the real one. */
  readonly transport?: HttpTransport;
}

/**
 * The OpenAI embedder and generator, with the dated price table, or a refusal.
 *
 * The generator runs in JSON mode: grounding asks for a JSON object in words, and a model that
 * wraps it in a code fence would fail every answer for a formatting reason. It also streams, so
 * that time to first token is measured (PRD 9.3, ADR 0012); the answer is still returned whole and
 * verified before release.
 */
export function openAiModelSet(
  env: Readonly<Record<string, string | undefined>>,
  options: OpenAiModelSetOptions = {},
): ProviderModelSet {
  const apiKey = openAiKeyFromEnv(env);
  const embeddingModel = options.embeddingModel ?? OPENAI_DEFAULT_EMBEDDING_MODEL;
  const generationModel = options.generationModel ?? OPENAI_DEFAULT_GENERATION_MODEL;
  const transport = options.transport === undefined ? {} : { transport: options.transport };

  const embedder = openAiEmbedder({
    apiKey,
    model: embeddingModel,
    dimension: OPENAI_DEFAULT_EMBEDDING_DIMENSION,
    ...transport,
  });
  const generator = openAiGenerator({
    apiKey,
    model: generationModel,
    jsonOutput: true,
    maxOutputTokens: 800,
    stream: true,
    ...transport,
  });

  return {
    embedder,
    embedding: embedder.model,
    generator,
    prices: OPENAI_PRICE_TABLE,
    identifiers: {
      embedder: embeddingModel,
      generator: generationModel,
      reranker: UNSELECTED_RERANKER,
    },
  };
}
