/**
 * The whole platform, constructed in memory with stand-in models.
 *
 * Six places built this by hand before it existed — the API, the worker, the evaluation runner, the
 * load run, the corpus inventory and RAG-02 — each with an identical stand-in embedder written out
 * again, while `model-gateway` already exported `fakeEmbedder`, which is the same thing. A second
 * exhibit needing it too is the moment PRD 11.2 names: promote the helper "into a package with a
 * defined contract — a deliberate, reviewed act", rather than copy it a seventh time or import it
 * sideways from the exhibit that wrote it first.
 *
 * **It is here, not in `composition`, because composition assembles and does not construct**
 * (ADR 0005). That rule is what stops the one package allowed to import everything from absorbing
 * everything. This package is the construction composition refuses to do, kept separate so that
 * refusal stays true. ADR 0008 records the new layer.
 *
 * **It is never for a deployment**, and the name is chosen to say so. Every store is in-process and
 * every model is a stand-in whose identifier announces it. A deployment constructs real adapters
 * and hands them to `composition` directly; nothing here has a configuration that would make it
 * serve real traffic, and `STAND_IN_MODELS` is exported so that a test can assert it never will.
 */

import {
  corpusSnapshotOf,
  corpusVersionOracle,
  createAnswerPipeline,
  createIngestionPipeline,
  indexingChunkSink,
  type AnswerPipeline,
  type IngestionPipeline,
} from "@atlasops/composition";
import {
  formatGroupId,
  parsePrincipalId,
  type ContentHash,
  type EmbeddingModelRef,
} from "@atlasops/contracts";
import { inMemoryCorpusStore, type CorpusStore } from "@atlasops/corpus";
import {
  inMemoryAuditSink,
  type GroupResolver,
  type RecordingAuditSink,
} from "@atlasops/governance";
import { STAND_IN_MODEL_ID, citingStandIn } from "@atlasops/grounding";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import type { ChunkSink, Connector } from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  fakeEmbedder,
  fakeReranker,
  inMemoryEmbeddingCache,
  realSleeper,
} from "@atlasops/model-gateway";
import { inMemoryRetrievalCache } from "@atlasops/retrieval";
import { systemClock } from "@atlasops/telemetry";

/**
 * The stand-in models, by role, as every artefact built on this package records them.
 *
 * Named rather than inferred, because PRD 12 item 2 requires an evaluation report to record the
 * model identifiers it used, and a reader has to be able to tell from those identifiers alone that
 * no model was involved.
 */
export const STAND_IN_MODELS = {
  embedder: "stand-in-embedder",
  reranker: "stand-in-reranker",
  generator: STAND_IN_MODEL_ID,
} as const;

/** The stand-in embedding, and the width every in-memory index built here is created for. */
export const STAND_IN_EMBEDDING: EmbeddingModelRef = {
  id: STAND_IN_MODELS.embedder,
  dimension: 64,
};

export interface SandboxOptions {
  readonly connector: Connector;
  /** Who may read what. A resolver rather than a map, so a test can make it fail closed. */
  readonly groups: GroupResolver;
  /**
   * Whether repeated queries are served from the retrieval cache.
   *
   * On by default, as a deployment would have it. The P15 load run showed what a repeating
   * workload does to a latency figure with it on, which is why a caller measuring the answer path
   * may want it off — and has to say so.
   */
  readonly retrievalCache?: boolean;
  /** Identifies the ingestion in the corpus's deletion records. */
  readonly ingestedBy?: string;
}

export interface Sandbox {
  readonly ingestion: IngestionPipeline;
  readonly answering: AnswerPipeline;
  readonly store: CorpusStore;
  /**
   * Every chunk written, with its offsets. `indexing` deliberately has no unfiltered accessor, so
   * this sink's own record is how a caller that needs a chunk's position — a line-level citation,
   * an inventory — gets it without widening the index.
   */
  readonly chunks: ChunkSink;
  readonly audit: RecordingAuditSink;
  /** The corpus snapshot hash, computed the same way the evaluation runner computes it. */
  readonly snapshot: () => ContentHash;
  readonly models: typeof STAND_IN_MODELS;
}

export function createSandbox(options: SandboxOptions): Sandbox {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(STAND_IN_EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const embeddingCache = inMemoryEmbeddingCache();
  // `fakeEmbedder`, not a seventh hand-written copy of it. Six places wrote their own before this
  // package existed; that is the duplication this package is here to end.
  const embeddings = createEmbeddingGateway(fakeEmbedder(STAND_IN_EMBEDDING), {
    sleeper: realSleeper,
    cache: embeddingCache,
  });
  const chunks = indexingChunkSink(lexical, vector);
  const audit = inMemoryAuditSink();
  const ingestedBy = options.ingestedBy ?? "prn_sandbox_ingest";

  const ingestion = createIngestionPipeline(
    {
      store,
      lexical,
      vector,
      embeddings,
      sleeper: realSleeper,
      clock: systemClock,
      connector: options.connector,
      chunks,
      embeddingCache,
    },
    {
      orderedBy: {
        id: parsePrincipalId(ingestedBy, "sandbox.ingestedBy"),
        groups: [formatGroupId("sandbox-ingest")],
      },
    },
  );

  const answering = createAnswerPipeline({
    store,
    lexical,
    vector,
    embeddings,
    sleeper: realSleeper,
    clock: systemClock,
    reranker: fakeReranker(STAND_IN_MODELS.reranker),
    generator: citingStandIn(),
    groups: options.groups,
    audit,
    oracle: corpusVersionOracle(store),
    ...(options.retrievalCache === false ? {} : { retrievalCache: inMemoryRetrievalCache() }),
    now: () => new Date().toISOString(),
  });

  return {
    ingestion,
    answering,
    store,
    chunks,
    audit,
    snapshot: () => corpusSnapshotOf(store),
    models: STAND_IN_MODELS,
  };
}
