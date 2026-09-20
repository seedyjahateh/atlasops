/**
 * The deterministic in-repo fakes.
 *
 * This is the module the standing bar in docs/PHASES.md refers to when it says no test may call a
 * paid API. Every package above this one embeds, reranks and generates through these, so the whole
 * suite runs offline, costs nothing, and produces the same answer on every machine.
 *
 * They are **deterministic, not random**. A fake that returned random vectors would make a
 * retrieval test pass or fail by luck, which is worse than no test. Same text in, same vector out;
 * different text in, reliably different vector out. That is enough to exercise every ranking,
 * fusion and caching path above without pretending to be a real model.
 *
 * What they are not: a quality signal. Nothing measured against these fakes says anything about
 * retrieval quality, and no number produced from them may be reported as one.
 */

import { contentHashDigest, contentHashOf, type EmbeddingModelRef } from "@atlasops/contracts";

import { ModelError, type ModelFailureKind } from "./errors.js";
import type {
  EmbedRequest,
  EmbedResult,
  Embedder,
  GenerateRequest,
  GenerateResult,
  Generator,
  RerankRequest,
  RerankResult,
  Reranker,
} from "./ports.js";

/** A crude but stable token estimate. Not a tokenizer, and never reported as one. */
export function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * A unit vector derived from the text's hash.
 *
 * Unit length so cosine similarity is a dot product and the numbers stay comparable; derived from
 * the hash so the mapping is stable across processes and machines.
 */
export function deterministicVector(text: string, dimension: number): readonly number[] {
  const values: number[] = [];
  let block = 0;

  while (values.length < dimension) {
    const digest = contentHashDigest(contentHashOf(`${text}\u001f${String(block)}`));
    for (let i = 0; i + 1 < digest.length && values.length < dimension; i += 2) {
      const byte = Number.parseInt(digest.slice(i, i + 2), 16);
      values.push(byte / 127.5 - 1);
    }
    block += 1;
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? values : values.map((value) => value / norm);
}

export function fakeEmbedder(
  model: EmbeddingModelRef = { id: "fake-embedder", dimension: 32 },
): Embedder {
  return {
    model,
    embed: (request: EmbedRequest): Promise<EmbedResult> =>
      Promise.resolve({
        model,
        vectors: request.texts.map((text) => deterministicVector(text, model.dimension)),
        usage: {
          inputTokens: request.texts.reduce((sum, text) => sum + approximateTokens(text), 0),
          outputTokens: 0,
        },
      }),
  };
}

function tokenise(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Scores by token overlap, which is deliberately a weak signal.
 *
 * It is enough to give a stable, explicable ordering that a test can reason about — "the candidate
 * sharing more query terms ranks higher" — without implying that a cross-encoder works this way.
 */
export function fakeReranker(modelId = "fake-reranker"): Reranker {
  return {
    modelId,
    rerank: (request: RerankRequest): Promise<RerankResult> => {
      const queryTokens = new Set(tokenise(request.query));
      const scores = request.candidates.map((candidate) => {
        const candidateTokens = tokenise(candidate.text);
        const overlap = candidateTokens.filter((token) => queryTokens.has(token)).length;
        return {
          id: candidate.id,
          score: candidateTokens.length === 0 ? 0 : overlap / candidateTokens.length,
        };
      });

      return Promise.resolve({
        modelId,
        scores: [...scores].sort((a, b) =>
          b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score,
        ),
        usage: {
          inputTokens:
            approximateTokens(request.query) +
            request.candidates.reduce(
              (sum, candidate) => sum + approximateTokens(candidate.text),
              0,
            ),
          outputTokens: 0,
        },
      });
    },
  };
}

export function fakeGenerator(
  modelId = "fake-generator",
  respond: (request: GenerateRequest) => string = (request) => `answer to: ${request.user}`,
): Generator {
  return {
    modelId,
    generate: (request: GenerateRequest): Promise<GenerateResult> => {
      const text = respond(request);
      return Promise.resolve({
        modelId,
        text,
        usage: {
          inputTokens: approximateTokens(request.system) + approximateTokens(request.user),
          outputTokens: approximateTokens(text),
        },
      });
    },
  };
}

/* ------------------------------------------------------------------ failure-path fakes */

/** Fails the first `failures` calls, then delegates. For exercising the retry schedule. */
export function flakyEmbedder(
  inner: Embedder,
  failures: number,
  kind: ModelFailureKind = "unavailable",
): Embedder {
  let remaining = failures;
  return {
    model: inner.model,
    embed: (request: EmbedRequest): Promise<EmbedResult> => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new ModelError("embedder", kind, "transient fixture failure"));
      }
      return inner.embed(request);
    },
  };
}

/** Always fails. For exercising PRD 9.4's degraded modes. */
export function unavailableReranker(kind: ModelFailureKind = "unavailable"): Reranker {
  return {
    modelId: "unavailable-reranker",
    rerank: (): Promise<RerankResult> =>
      Promise.reject(new ModelError("reranker", kind, "fixture is unavailable")),
  };
}

export function unavailableGenerator(kind: ModelFailureKind = "unavailable"): Generator {
  return {
    modelId: "unavailable-generator",
    generate: (): Promise<GenerateResult> =>
      Promise.reject(new ModelError("generator", kind, "fixture is unavailable")),
  };
}

/** Counts calls, so a cache test can prove the inner model was not reached. */
export function countingEmbedder(
  inner: Embedder,
): Embedder & { calls: () => number; textsSeen: () => number } {
  let calls = 0;
  let texts = 0;
  return {
    model: inner.model,
    embed: (request: EmbedRequest): Promise<EmbedResult> => {
      calls += 1;
      texts += request.texts.length;
      return inner.embed(request);
    },
    calls: (): number => calls,
    textsSeen: (): number => texts,
  };
}
