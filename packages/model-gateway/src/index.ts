/**
 * The public surface of `@atlasops/model-gateway`.
 *
 * Layer 2, and the only module in the repository a provider SDK may enter. `layers.json` lists this
 * package in `providerSdks.allowedIn`; every other module importing `openai`, `@anthropic-ai/*` or
 * any other listed SDK fails `pnpm boundaries:check` by name.
 *
 * That is what makes the fakes below load-bearing rather than a convenience. Everything above
 * depends on `Embedder`, `Reranker` and `Generator`, so the whole suite runs offline and costs
 * nothing — and swapping a provider is a change confined to this directory.
 */

export { MODEL_FAILURE_KINDS, ModelError, isModelError, type ModelFailureKind } from "./errors.js";

export {
  DEFAULT_RETRY_POLICY,
  backoffFor,
  realSleeper,
  recordingSleeper,
  withRetry,
  type Attempted,
  type RecordingSleeper,
  type RetryPolicy,
  type Sleeper,
} from "./retry.js";

export {
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
  type GenerateRequest,
  type GenerateResult,
  type Generator,
  type RerankCandidate,
  type RerankRequest,
  type RerankResult,
  type RerankScore,
  type Reranker,
  type Usage,
} from "./ports.js";

export {
  embeddingCacheKey,
  inMemoryEmbeddingCache,
  type EmbeddingCache,
  type RecordingEmbeddingCache,
} from "./cache.js";

export {
  approximateTokens,
  countingEmbedder,
  deterministicVector,
  fakeEmbedder,
  fakeGenerator,
  fakeReranker,
  flakyEmbedder,
  unavailableGenerator,
  unavailableReranker,
} from "./fake.js";

export {
  DEFAULT_TIMEOUT_MS,
  OPENAI_BASE_URL,
  failureKindForStatus,
  openAiEmbedder,
  openAiGenerator,
  openAiKeyFromEnv,
  redactKey,
  type OpenAiConfig,
  type OpenAiEmbedderConfig,
  type OpenAiGeneratorConfig,
} from "./openai.js";

export {
  OPENAI_DEFAULT_EMBEDDING_DIMENSION,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  OPENAI_DEFAULT_GENERATION_MODEL,
  OPENAI_PRICE_TABLE,
} from "./prices-openai.js";

export {
  fetchTransport,
  recordingTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type RecordedExchange,
  type RecordingTransport,
} from "./transport.js";

export {
  createEmbeddingGateway,
  generateWithRetry,
  rerankWithRetry,
  toModelCall,
  type CallOutcome,
  type EmbedOutcome,
  type EmbeddingGateway,
  type GatewayOptions,
  type GenerateOutcome,
  type RerankOutcome,
} from "./gateway.js";
