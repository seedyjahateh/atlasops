/**
 * The retrieval pipeline (PRD 5.1 to 5.5, 6.3, 9.2, 9.4).
 *
 * Two arms in parallel over the same corpus with identical permission filters, fused by rank,
 * reranked, cut to the limit. The permission filter is not applied here at all — it is compiled
 * once and handed to both indexes, which is what PRD 6.2 means by "applied by both the vector index
 * and the lexical index during candidate generation". There is no line in this file that drops a
 * candidate for permission reasons, and there is deliberately nowhere one could be added: nothing
 * reaches this code that the principal may not read.
 *
 * **Degraded modes are per-dependency and typed** (PRD 9.4). A retriever that is unavailable
 * degrades to the other arm and marks the result; a reranker that is unavailable is bypassed and
 * marks the result. A `MIXED_EMBEDDING_MODEL` failure does **not** degrade — it is a configuration
 * defect, and quietly serving lexical-only past it would hide a broken index behind a slightly
 * worse ranking for as long as nobody read the flag.
 *
 * **The temporal filter runs between the arms and fusion, and renumbers.** Removing a superseded
 * chunk without renumbering would leave a gap in the rank sequence, and RRF reads ranks — a live
 * document behind a superseded one would be scored as though it were one place worse than it is.
 * The residual limitation is named rather than hidden: the index's depth cutoff still counted the
 * superseded rows, so this is a second line of defence. The first is that `ingest` purges
 * superseded versions from the index, which is also why an `as-of` query is only answerable over an
 * index configured to retain them.
 */

import { isAtlasOpsError, type RequestId } from "@atlasops/contracts";
import type { Principal } from "@atlasops/governance";
import {
  compilePredicate,
  type Candidate,
  type CompiledPredicate,
  type ExistenceProbe,
  type LexicalIndex,
  type VectorIndex,
} from "@atlasops/indexing";
import {
  isModelError,
  rerankWithRetry,
  type EmbeddingGateway,
  type Reranker,
  type Sleeper,
} from "@atlasops/model-gateway";
import { createTrace, systemClock, type Clock, type Trace } from "@atlasops/telemetry";

import { RETRIEVAL_DEFAULTS, validateConfig, type RetrievalConfig } from "./config.js";
import { retrievalCacheKey, type RetrievalCache } from "./cache.js";
import { reciprocalRankFusion, type FusedCandidate, type RankedList } from "./fusion.js";
import { analyseQuery, type AnalysedQuery } from "./query.js";
import { admits, type VersionOracle } from "./temporal.js";

export interface RetrievalPorts {
  readonly lexical: LexicalIndex;
  readonly vector: VectorIndex;
  readonly embeddings: EmbeddingGateway;
  readonly reranker: Reranker;
  readonly oracle: VersionOracle;
  readonly sleeper: Sleeper;
  readonly cache?: RetrievalCache;
  readonly clock?: Clock;
}

export interface RetrievalRequest {
  readonly query: string;
  /** Already resolved. PRD 9.4: permission resolution has no degraded mode and fails upstream. */
  readonly principal: Principal;
  readonly requestId: RequestId;
  readonly config?: RetrievalConfig;
}

export type DegradedReason = "dense-unavailable" | "lexical-unavailable" | "reranker-unavailable";

export interface RetrievalResult {
  readonly candidates: readonly FusedCandidate[];
  /** What went to both indexes, and what PRD 6.6's audit record stores. */
  readonly predicate: CompiledPredicate;
  readonly query: AnalysedQuery;
  /** Including its provenance, so no artefact can quote a number as tuned that was not. */
  readonly config: RetrievalConfig;
  readonly degraded: readonly DegradedReason[];
  readonly cacheHit: boolean;
  readonly trace: Trace;
  /** Run only when nothing was retrieved. PRD 6.4 decides the wording from this. */
  readonly existence: ExistenceProbe | null;
  /** How many candidates the temporal filter removed. Evidence for PRD 5.5. */
  readonly supersededRemoved: number;
}

/** A configuration defect must not be absorbed as an outage. See the file header. */
function isConfigurationDefect(error: unknown): boolean {
  return isAtlasOpsError(error) && error.code === "MIXED_EMBEDDING_MODEL";
}

/** Drop what the temporal scope excludes, then renumber. See the file header on renumbering. */
function applyScope(
  candidates: readonly Candidate[],
  oracle: VersionOracle,
  config: RetrievalConfig,
): { readonly kept: readonly Candidate[]; readonly removed: number } {
  const kept = candidates.filter((candidate) =>
    admits(oracle, config.temporal, candidate.sourceId, candidate.sourceVersionId),
  );
  return {
    kept: kept.map((candidate, position) => ({ ...candidate, rank: position + 1 })),
    removed: candidates.length - kept.length,
  };
}

export async function retrieve(
  ports: RetrievalPorts,
  request: RetrievalRequest,
): Promise<RetrievalResult> {
  const config = validateConfig(request.config ?? RETRIEVAL_DEFAULTS);
  const trace = createTrace(request.requestId, ports.clock ?? systemClock);
  const degraded: DegradedReason[] = [];

  const normalisation = trace.span("query-normalisation");
  const query = analyseQuery(request.query);
  const predicate = compilePredicate(request.principal);
  normalisation.end();

  const cacheKey = retrievalCacheKey(query, predicate.groupSetHash, config);
  const cached = ports.cache?.get(cacheKey);
  if (cached !== undefined) {
    return {
      candidates: cached,
      predicate,
      query,
      config,
      degraded,
      cacheHit: true,
      trace: trace.finish(),
      existence: null,
      supersededRemoved: 0,
    };
  }

  const lists: RankedList[] = [];
  let supersededRemoved = 0;

  if (config.dense.enabled) {
    const span = trace.span("dense-retrieval");
    try {
      const embedded = await ports.embeddings.embed([query.normalised]);
      const vector = embedded.vectors[0] ?? [];
      const candidates = await ports.vector.search({
        vector,
        embedding: ports.embeddings.model,
        predicate,
        limit: config.dense.depth,
      });
      const scoped = applyScope(candidates, ports.oracle, config);
      supersededRemoved += scoped.removed;
      lists.push({ retriever: "dense", candidates: scoped.kept });
      span.end();
    } catch (error) {
      span.end({ degraded: true });
      if (isConfigurationDefect(error)) throw error;
      if (!isModelError(error) && !(error instanceof Error)) throw error;
      degraded.push("dense-unavailable");
    }
  }

  if (config.lexical.enabled) {
    const span = trace.span("lexical-retrieval");
    try {
      const candidates = await ports.lexical.search({
        query: query.lexical,
        predicate,
        limit: config.lexical.depth,
      });
      const scoped = applyScope(candidates, ports.oracle, config);
      supersededRemoved += scoped.removed;
      lists.push({ retriever: "lexical", candidates: scoped.kept });
      span.end();
    } catch (error) {
      span.end({ degraded: true });
      if (isConfigurationDefect(error)) throw error;
      degraded.push("lexical-unavailable");
    }
  }

  const fusion = trace.span("fusion");
  const fused = reciprocalRankFusion(
    lists,
    config.fusionK,
    config.rerank.enabled ? config.rerank.depth : config.limit,
  );
  fusion.end();

  let candidates = fused;

  if (config.rerank.enabled && fused.length > 0) {
    const span = trace.span("reranking");
    try {
      const outcome = await rerankWithRetry(
        ports.reranker,
        {
          query: query.normalised,
          candidates: fused.map((candidate) => ({
            id: candidate.chunkId,
            text: candidate.text,
          })),
        },
        { sleeper: ports.sleeper },
      );

      const byId = new Map(fused.map((candidate) => [candidate.chunkId, candidate]));
      candidates = outcome.result.scores.flatMap((score, position) => {
        const candidate = byId.get(score.id as FusedCandidate["chunkId"]);
        return candidate === undefined
          ? []
          : [{ ...candidate, rank: position + 1, rerankScore: score.score }];
      });
      span.end();
    } catch (error) {
      // PRD 9.4: serve fused results with reranking bypassed, marked degraded, and continue.
      // Answer quality drops; correctness of citation and permission does not.
      span.end({ degraded: true });
      if (isConfigurationDefect(error)) throw error;
      degraded.push("reranker-unavailable");
    }
  }

  candidates = candidates
    .slice(0, config.limit)
    .map((candidate, position) => ({ ...candidate, rank: position + 1 }));

  ports.cache?.set(cacheKey, candidates);

  // Only when there is nothing to answer from. Probing on every query would spend work looking at
  // material the principal cannot read in order to answer a question nobody asked.
  const existence =
    candidates.length === 0
      ? await ports.lexical.probeWithheld({
          query: query.lexical,
          predicate,
          limit: config.limit,
        })
      : null;

  return {
    candidates,
    predicate,
    query,
    config,
    degraded,
    cacheHit: false,
    trace: trace.finish(),
    existence,
    supersededRemoved,
  };
}
