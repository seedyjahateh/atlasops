/**
 * Everything the pipelines need from the outside, in one place (ADR 0005).
 *
 * This package assembles; it does not construct. Every dependency arrives as a value an
 * application built — an index, a gateway, a store, a sink, a clock — so the composition root can
 * be exercised end to end against in-repo fakes and deployed against real services without one
 * line of it changing.
 *
 * The rule that keeps this package from becoming the one that swallows the codebase: **nothing
 * here opens a connection, reads an environment variable, or parses a configuration file.** Those
 * are the application's job, and a composition root that did them would be an application that
 * other applications import, which is the thing PRD 11.2 forbids.
 */

import type { AuditSink, GroupResolver } from "@atlasops/governance";
import type { ChunkSink, Connector, TokenCounter } from "@atlasops/ingest";
import type { LexicalIndex, VectorIndex } from "@atlasops/indexing";
import type { CorpusStore } from "@atlasops/corpus";
import type {
  EmbeddingCache,
  EmbeddingGateway,
  Generator,
  Reranker,
  Sleeper,
} from "@atlasops/model-gateway";
import type { PriceTable } from "@atlasops/telemetry";
import type { RetrievalCache, VersionOracle } from "@atlasops/retrieval";
import type { Clock } from "@atlasops/telemetry";

/** What both pipelines share. */
export interface CorePorts {
  readonly store: CorpusStore;
  readonly lexical: LexicalIndex;
  readonly vector: VectorIndex;
  readonly embeddings: EmbeddingGateway;
  readonly sleeper: Sleeper;
  /** Monotonic, for durations. Never for an audit timestamp. */
  readonly clock: Clock;
  readonly prices?: PriceTable | undefined;
}

export interface AnswerPorts extends CorePorts {
  readonly reranker: Reranker;
  readonly generator: Generator;
  readonly groups: GroupResolver;
  readonly audit: AuditSink;
  readonly oracle: VersionOracle;
  readonly retrievalCache?: RetrievalCache | undefined;
  /** Wall-clock time as an ISO instant, for the audit record. */
  readonly now: () => string;
}

export interface IngestionPorts extends CorePorts {
  readonly connector: Connector;
  readonly chunks: ChunkSink;
  readonly embeddingCache?: EmbeddingCache | undefined;
  readonly tokenCounter?: TokenCounter | undefined;
}
