/**
 * Composition: cache, retry, and the usage record telemetry needs.
 *
 * The order matters and is the opposite of the obvious one. **Cache first, retry inside.** Checking
 * the cache before the retry loop means a cached text never enters it at all; wrapping the cache in
 * retry would re-check an in-memory map three times on the way to a failure that had nothing to do
 * with it.
 *
 * Only the texts that miss are sent. A gateway that re-embeds the whole batch when one chunk
 * changed is the difference between PRD 4.2's "chunks whose own text hash is unchanged reuse their
 * existing embedding" and a re-ingestion that costs the same as the first one.
 */

import type { EmbeddingModelRef } from "@atlasops/contracts";
import { canPrice, costOf, type ModelCall, type PriceTable } from "@atlasops/telemetry";

import { embeddingCacheKey, type EmbeddingCache } from "./cache.js";
import type {
  EmbedResult,
  Embedder,
  GenerateRequest,
  GenerateResult,
  Generator,
  RerankRequest,
  RerankResult,
  Reranker,
  Usage,
} from "./ports.js";
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy, type Sleeper } from "./retry.js";

export interface GatewayOptions {
  readonly policy?: RetryPolicy;
  readonly sleeper: Sleeper;
  readonly jitter?: (delay: number) => number;
}

/** What a call cost in attempts and cache hits, for the span telemetry records. */
export interface CallOutcome {
  readonly attempts: number;
  readonly cacheHits: number;
}

export interface EmbedOutcome extends CallOutcome {
  readonly model: EmbeddingModelRef;
  readonly vectors: readonly (readonly number[])[];
  readonly usage: Usage;
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export interface EmbeddingGateway {
  readonly model: EmbeddingModelRef;
  readonly embed: (texts: readonly string[]) => Promise<EmbedOutcome>;
}

export function createEmbeddingGateway(
  embedder: Embedder,
  options: GatewayOptions & { readonly cache?: EmbeddingCache },
): EmbeddingGateway {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const cache = options.cache;

  return {
    model: embedder.model,

    async embed(texts: readonly string[]): Promise<EmbedOutcome> {
      const vectors = new Array<readonly number[] | undefined>(texts.length);
      const missIndexes: number[] = [];

      texts.forEach((text, index) => {
        const cached = cache?.get(embeddingCacheKey(embedder.model, text));
        if (cached === undefined) missIndexes.push(index);
        else vectors[index] = cached;
      });

      // Every text was cached. No model call, no attempt, no usage — and nothing to retry.
      if (missIndexes.length === 0) {
        return {
          model: embedder.model,
          vectors: vectors as readonly (readonly number[])[],
          usage: NO_USAGE,
          attempts: 0,
          cacheHits: texts.length,
        };
      }

      const misses = missIndexes.map((index) => texts[index] ?? "");
      const attempted = await withRetry(
        () => embedder.embed({ texts: misses }),
        policy,
        options.sleeper,
        options.jitter,
      );

      const result: EmbedResult = attempted.value;
      if (result.vectors.length !== misses.length) {
        throw new Error(
          `embedder returned ${String(result.vectors.length)} vectors for ` +
            `${String(misses.length)} texts`,
        );
      }

      missIndexes.forEach((target, position) => {
        const vector = result.vectors[position];
        if (vector === undefined) return;
        vectors[target] = vector;
        cache?.set(embeddingCacheKey(embedder.model, texts[target] ?? ""), vector);
      });

      return {
        model: result.model,
        vectors: vectors as readonly (readonly number[])[],
        usage: result.usage,
        attempts: attempted.attempts,
        cacheHits: texts.length - misses.length,
      };
    },
  };
}

export interface RerankOutcome extends CallOutcome {
  readonly result: RerankResult;
}

export async function rerankWithRetry(
  reranker: Reranker,
  request: RerankRequest,
  options: GatewayOptions,
): Promise<RerankOutcome> {
  const attempted = await withRetry(
    () => reranker.rerank(request),
    options.policy ?? DEFAULT_RETRY_POLICY,
    options.sleeper,
    options.jitter,
  );
  return { result: attempted.value, attempts: attempted.attempts, cacheHits: 0 };
}

export interface GenerateOutcome extends CallOutcome {
  readonly result: GenerateResult;
}

export async function generateWithRetry(
  generator: Generator,
  request: GenerateRequest,
  options: GatewayOptions,
): Promise<GenerateOutcome> {
  const attempted = await withRetry(
    () => generator.generate(request),
    options.policy ?? DEFAULT_RETRY_POLICY,
    options.sleeper,
    options.jitter,
  );
  return { result: attempted.value, attempts: attempted.attempts, cacheHits: 0 };
}

/**
 * The bridge to telemetry: usage plus a price table becomes a `ModelCall` for a span.
 *
 * `retries` is attempts minus one, because PRD 9.2 asks for a retry count and the first call is not
 * a retry. A fully cached embed reports zero attempts, so its retry count floors at zero rather
 * than going negative.
 */
export function toModelCall(input: {
  readonly modelId: string;
  readonly usage: Usage;
  readonly outcome: CallOutcome;
  readonly priceTable: PriceTable;
  readonly totalTexts?: number;
}): ModelCall {
  const cacheHit =
    input.totalTexts === undefined
      ? input.outcome.cacheHits > 0
      : input.outcome.cacheHits === input.totalTexts;

  return {
    modelId: input.modelId,
    // Null rather than a throw when the table cannot price this model (ADR 0002). Throwing here
    // would mean a stand-in could not be traced at all, and the stage would go uninstrumented —
    // which is how PRD 9.3's verification and generation budgets came to have nothing to
    // aggregate. Null keeps the span and refuses the number.
    cost: canPrice(input.priceTable, input.modelId)
      ? costOf(input.priceTable, input.modelId, input.usage.inputTokens, input.usage.outputTokens)
      : null,
    cacheHit,
    retries: Math.max(0, input.outcome.attempts - 1),
  };
}
