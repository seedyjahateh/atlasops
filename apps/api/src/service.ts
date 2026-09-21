/**
 * The answer service: ports assembled, and a request shaped into an answer.
 *
 * Separated from `main.ts` so that everything with a decision in it can be tested without binding a
 * socket. `main.ts` is the part that binds, listens and exits; nothing there is worth a test and
 * nothing here needs a port number.
 *
 * **The API resolves nothing about permissions itself.** It reads a principal identifier off the
 * request and hands it to the pipeline, which resolves groups at query time and fails closed (PRD
 * 6.1, 9.4). A transport that resolved groups would be a second place authorisation happens, and
 * the second place is always the one that drifts.
 *
 * **The abstention reason is not in the response.** `GroundingResult.message` is, and it goes
 * through `governance`'s wording, where "material exists that you may not see" and "nothing was
 * found" are the same bytes for a `hidden` source (PRD 6.4). Returning the reason would hand a
 * caller the enumeration oracle the whole of 6.4 closes — which is exactly the kind of thing a
 * transport layer does without noticing.
 */

import {
  formatGroupId,
  formatRequestId,
  isAtlasOpsError,
  parsePrincipalId,
} from "@atlasops/contracts";
import {
  corpusVersionOracle,
  createAnswerPipeline,
  createIngestionPipeline,
  indexingChunkSink,
  type AnswerPipeline,
} from "@atlasops/composition";
import { inMemoryCorpusStore } from "@atlasops/corpus";
import {
  inMemoryAuditSink,
  staticGroupResolver,
  type RecordingAuditSink,
} from "@atlasops/governance";
import { citingStandIn } from "@atlasops/grounding";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import { filesystemConnector, structureAware } from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  deterministicVector,
  fakeReranker,
  inMemoryEmbeddingCache,
  realSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
} from "@atlasops/model-gateway";
import { inMemoryRetrievalCache } from "@atlasops/retrieval";
import { systemClock } from "@atlasops/telemetry";

import type { ApiConfig } from "./config.js";

const EMBEDDING = { id: "stand-in-embedder", dimension: 64 };

/**
 * The stand-in embedder, named so nobody mistakes it for a model.
 *
 * `model-gateway` ships this shape as `fakeEmbedder`; it is constructed here rather than imported
 * under that name so the model identifier in every chunk and every trace says what it is.
 */
const standInEmbedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map((text) => deterministicVector(text, EMBEDDING.dimension)),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

export interface AnswerService {
  readonly pipeline: AnswerPipeline;
  readonly audit: RecordingAuditSink;
  /** Crawls the bootstrap corpus, if one is configured. Returns how many chunks it wrote. */
  readonly bootstrap: () => Promise<number>;
}

export function createAnswerService(config: ApiConfig): AnswerService {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const sleeper = realSleeper;
  const cache = inMemoryEmbeddingCache();
  const embeddings = createEmbeddingGateway(standInEmbedder, { sleeper, cache });
  const audit = inMemoryAuditSink();
  const group = formatGroupId(config.corpusGroup);

  const pipeline = createAnswerPipeline({
    store,
    lexical,
    vector,
    embeddings,
    sleeper,
    clock: systemClock,
    reranker: fakeReranker("stand-in-reranker"),
    generator: citingStandIn(),
    // One principal, whose group is the one the bootstrap corpus carries. A real deployment
    // resolves this against a directory; the resolver is a port precisely so that swap is a
    // configuration change rather than a rewrite.
    groups: staticGroupResolver({ prn_reader: [group] }),
    audit,
    oracle: corpusVersionOracle(store),
    retrievalCache: inMemoryRetrievalCache(),
    now: () => new Date().toISOString(),
  });

  const bootstrap = async (): Promise<number> => {
    if (config.bootstrapCorpus === null) return 0;

    const ingestion = createIngestionPipeline(
      {
        store,
        lexical,
        vector,
        embeddings,
        sleeper,
        clock: systemClock,
        connector: filesystemConnector({
          root: config.bootstrapCorpus,
          strategy: structureAware({ maxTokens: 256, boundaryDepth: 2 }),
          acl: { readableBy: [group], existence: "visible" },
          now: () => new Date().toISOString(),
        }),
        chunks: indexingChunkSink(lexical, vector),
        embeddingCache: cache,
      },
      { orderedBy: { id: parsePrincipalId("prn_api_bootstrap", "api"), groups: [group] } },
    );

    const report = await ingestion.run();
    return report.chunksWritten;
  };

  return { pipeline, audit, bootstrap };
}

export interface AnswerHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export interface AnswerHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

interface AnswerBody {
  readonly query?: unknown;
  readonly principal?: unknown;
  readonly requestId?: unknown;
}

export async function handle(
  service: AnswerService,
  request: AnswerHttpRequest,
): Promise<AnswerHttpResponse> {
  if (request.method === "GET" && request.path === "/health") {
    return { status: 200, body: { status: "ok" } };
  }

  if (request.method !== "POST" || request.path !== "/answer") {
    return { status: 404, body: { error: "no route", path: request.path } };
  }

  let body: AnswerBody;
  try {
    body = JSON.parse(request.body) as AnswerBody;
  } catch {
    return { status: 400, body: { error: "the request body is not JSON" } };
  }

  if (typeof body.query !== "string" || body.query.trim().length === 0) {
    return { status: 400, body: { error: "query must be a non-empty string" } };
  }
  if (typeof body.principal !== "string") {
    return { status: 400, body: { error: "principal must be a string" } };
  }

  try {
    const outcome = await service.pipeline.answer({
      requestId: formatRequestId(
        typeof body.requestId === "string" && body.requestId.length > 0
          ? body.requestId
          : `api-${String(Date.now())}`,
      ),
      principalId: parsePrincipalId(body.principal, "principal"),
      query: body.query,
    });

    return {
      status: 200,
      body: {
        // The message, never the abstention reason. See the file header.
        message: outcome.grounding.message,
        abstained: outcome.grounding.answer.abstained,
        citations: outcome.grounding.answer.abstained
          ? []
          : outcome.grounding.answer.segments.flatMap((segment) =>
              segment.references.map((reference) => ({
                chunkId: reference.chunkId,
                sourceVersionId: reference.sourceVersionId,
              })),
            ),
        degraded: outcome.retrieval.degraded,
        requestId: outcome.grounding.audit.requestId,
      },
    };
  } catch (error) {
    if (isAtlasOpsError(error) && error.code === "ACL_UNRESOLVED") {
      // PRD 9.4's one dependency with no degraded mode. A 503 rather than a 500: the request was
      // well formed and the system could not establish what the caller may read.
      return { status: 503, body: { error: "permission resolution is unavailable" } };
    }
    if (isAtlasOpsError(error) && error.code === "VALIDATION") {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}
