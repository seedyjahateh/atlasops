/**
 * The three capabilities, as interfaces.
 *
 * Interfaces first is the whole point of this layer. Everything above depends on these shapes and
 * never on a provider, which is what lets every downstream test run against the deterministic fake
 * instead of a paid API — and what makes PRD 5.3's requirement that "the reranker is bypassable by
 * configuration" a one-line substitution rather than a refactor.
 *
 * Token usage is returned by every call, not looked up afterwards. PRD 9.2 requires cost to be
 * attributable per request, and a usage figure fetched later cannot be attributed to the span that
 * caused it.
 */

import type { EmbeddingModelRef } from "@atlasops/contracts";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface EmbedRequest {
  readonly texts: readonly string[];
  readonly signal?: AbortSignal | undefined;
}

export interface EmbedResult {
  /** Which model produced these vectors. Carried per result so a mix is detectable (PRD 4.4). */
  readonly model: EmbeddingModelRef;
  readonly vectors: readonly (readonly number[])[];
  readonly usage: Usage;
}

export interface Embedder {
  readonly model: EmbeddingModelRef;
  readonly embed: (request: EmbedRequest) => Promise<EmbedResult>;
}

export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

export interface RerankScore {
  readonly id: string;
  readonly score: number;
}

export interface RerankResult {
  readonly modelId: string;
  /** Descending by score. The gateway sorts, so no caller has to remember to. */
  readonly scores: readonly RerankScore[];
  readonly usage: Usage;
}

export interface RerankRequest {
  readonly query: string;
  readonly candidates: readonly RerankCandidate[];
  readonly signal?: AbortSignal | undefined;
}

export interface Reranker {
  readonly modelId: string;
  readonly rerank: (request: RerankRequest) => Promise<RerankResult>;
}

export interface GenerateRequest {
  /** The instruction block. Retrieved passages never go here — see PRD 6.5 and P9. */
  readonly system: string;
  readonly user: string;
  readonly signal?: AbortSignal | undefined;
}

export interface GenerateResult {
  readonly modelId: string;
  readonly text: string;
  readonly usage: Usage;
  /**
   * Milliseconds from sending the request to the first token of output, on the attempt that
   * succeeded. Present only when the generator streams: a generator that returns its whole answer
   * at once (every stand-in, and the adapter with streaming off) has no first token to time, and a
   * whole-response latency is not one (PRD 9.3).
   */
  readonly firstTokenMs?: number;
  /**
   * Milliseconds from sending the request to the end of the response, on the same attempt. Carried
   * with `firstTokenMs` so a caller can place the first token on its own clock by working back from
   * when the call returned — which stays right through retries, where working forward from when the
   * call started would not.
   */
  readonly responseMs?: number;
}

export interface Generator {
  readonly modelId: string;
  readonly generate: (request: GenerateRequest) => Promise<GenerateResult>;
}
