/**
 * The ingestion pipeline (PRD 4.2, 4.5).
 *
 * List, compare hashes, fetch only what moved, chunk it, embed only the chunks whose text is new,
 * write the index, advance the corpus, purge what the change superseded. Every interesting property
 * of this file is about what it does *not* do.
 *
 * **The index is written before the corpus records the version live.** That ordering is chosen, and
 * it is the opposite of the obvious one. If the index write fails after the corpus advanced, the
 * corpus claims a live version that retrieval cannot see, and nothing will ever retry it — the next
 * crawl compares hashes, finds the source unchanged, and does nothing. Writing the index first
 * inverts the failure: the corpus stays where it was, the next run retries, and the only debris is
 * chunks for a version the corpus never made live. Those are invisible to retrieval, because
 * eligibility is computed from the corpus rather than stored on the chunk (`isRetrievable`), so the
 * cost is wasted space and the alternative is a document that silently stops being findable.
 *
 * **A revision purges the old version from the index but never from the embedding cache.** The
 * cache is keyed on chunk text, and that is precisely the mechanism PRD 4.2's chunk reuse runs on:
 * most revisions touch a minority of a document, so most chunks come back byte-identical and must
 * not be paid for twice. Eviction happens on deletion only, where leaving a derivative behind would
 * mean the deletion did not happen.
 *
 * **What this pipeline does not do: refresh access labels.** A connector listing carries identity
 * and a content hash, so a permission change with no content change is invisible to it. That is a
 * real gap and it is named here rather than papered over — label refresh belongs to a separate pass
 * driven by the directory, not to a content crawl. The one case that does surface is handled: if a
 * source reverts between `list` and `fetch`, the corpus reports `acl-changed` and the chunks are
 * relabelled in place, with no re-embedding.
 */

import {
  isAtlasOpsError,
  type ChunkId,
  type SourceId,
  type SourceVersionId,
} from "@atlasops/contracts";
import {
  detectChanges,
  observedVersionId,
  versionFrom,
  type ChangeSet,
  type CorpusStore,
  type VersionRef,
} from "@atlasops/corpus";
import type { Principal } from "@atlasops/governance";
import {
  embeddingCacheKey,
  type EmbeddingCache,
  type EmbeddingGateway,
} from "@atlasops/model-gateway";

import { chunksFor, textOf } from "./assemble.js";
import type { Connector } from "./connector.js";
import type { ChunkSink, StoredChunk } from "./sink.js";
import type { TokenCounter } from "./tokens.js";

export interface IngestionRun {
  readonly connector: Connector;
  readonly store: CorpusStore;
  readonly gateway: EmbeddingGateway;
  readonly sink: ChunkSink;
  /** Who a crawl-detected deletion is attributed to. The corpus refuses an unattributed one. */
  readonly orderedBy: Principal;
  /** The same cache the gateway holds, so a deletion can evict it. */
  readonly cache?: EmbeddingCache;
  readonly tokenCounter?: TokenCounter;
}

export type Disposition =
  "added" | "modified" | "unchanged" | "relabelled" | "deleted" | "tombstoned" | "failed";

export interface SourceOutcome {
  readonly sourceId: SourceId;
  readonly disposition: Disposition;
  /** Chunks written for this source in this run. */
  readonly chunks: number;
  /** Chunk texts sent to the embedding model. */
  readonly embedded: number;
  /** Chunk texts served from cache — PRD 4.2's reuse, counted. */
  readonly reused: number;
  readonly purged: number;
  readonly error: string | null;
}

export interface IngestionReport {
  readonly connector: string;
  readonly observedAt: string;
  readonly changes: ChangeSet;
  readonly outcomes: readonly SourceOutcome[];
  /** How many times content was actually asked for. Zero on a run with no changes. */
  readonly fetched: number;
  /** How many sources were parsed and chunked. */
  readonly parsed: number;
  /** How many embedding calls reached the model. Zero when everything was cached. */
  readonly modelCalls: number;
  readonly chunksWritten: number;
  readonly chunksPurged: number;
  readonly cacheEvictions: number;
  /**
   * Input tokens the embedder reported, summed over the run.
   *
   * From the model's own usage record, not from the chunker's estimate — PRD 9.3 budgets ingestion
   * cost by "embedding token accounting over the fixture", and an accounting built on an
   * approximation is not one.
   */
  readonly embeddingTokens: number;
  readonly failures: readonly SourceOutcome[];
  /** True when the listing was incomplete, so absence was not read as deletion. */
  readonly deletionsWithheld: boolean;
}

function messageOf(error: unknown): string {
  if (isAtlasOpsError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export async function ingest(run: IngestionRun): Promise<IngestionReport> {
  const { connector, store, gateway, sink } = run;

  const listing = await connector.list();
  const changes = detectChanges(store, listing);

  const outcomes: SourceOutcome[] = [];
  let fetched = 0;
  let parsed = 0;
  let modelCalls = 0;
  let chunksWritten = 0;
  let chunksPurged = 0;
  let cacheEvictions = 0;
  let embeddingTokens = 0;

  for (const sourceId of changes.unchanged) {
    // Not fetched, not parsed, not embedded. One hash comparison, and that is the whole cost.
    outcomes.push(blank(sourceId, "unchanged"));
  }

  for (const sourceId of changes.tombstoned) {
    outcomes.push(blank(sourceId, "tombstoned"));
  }

  for (const sourceId of [...changes.added, ...changes.modified]) {
    const wasAdded = changes.added.includes(sourceId);
    try {
      fetched += 1;
      const source = await connector.fetch(sourceId);

      const previousHead = store.state(sourceId)?.head ?? null;

      // The listing said this source moved, and the bytes that came back are the ones already
      // live. A real race: it was edited and reverted between the two calls. There is nothing to
      // chunk and nothing to embed — but the label may have moved with it, and relabelling is the
      // one write that costs no model call (ADR 0003).
      if (observedVersionId(source.observation) === previousHead) {
        const reverted = store.append(source.observation);
        if (reverted.outcome === "acl-changed") {
          await sink.relabel(sourceId, reverted.version.acl);
        }
        outcomes.push(
          blank(sourceId, reverted.outcome === "acl-changed" ? "relabelled" : "unchanged"),
        );
        continue;
      }

      // Built without touching the store, so the index can be written before the corpus advances.
      // `versionFrom` runs the same derivation and the same validation `append` will.
      const version = versionFrom(source.observation, previousHead);

      const chunks = chunksFor({
        version,
        text: source.text,
        strategy: connector.strategy,
        embedding: gateway.model,
        ...(run.tokenCounter === undefined ? {} : { tokenCounter: run.tokenCounter }),
      });
      parsed += 1;

      const texts = chunks.map((chunk) => textOf(chunk, source.text));
      const embedded = await gateway.embed(texts);
      if (embedded.attempts > 0) modelCalls += 1;
      embeddingTokens += embedded.usage.inputTokens;

      const stored: StoredChunk[] = chunks.map((chunk, index) => ({
        chunk,
        text: texts[index] ?? "",
        vector: embedded.vectors[index] ?? [],
      }));
      await sink.put(stored);

      // Only now does the corpus make this version live — after the index already holds it.
      store.append(source.observation);
      chunksWritten += stored.length;

      // Retention keeps only the head live (PRD 4.1), so the version this one replaces leaves the
      // index now. Its vectors stay in the cache on purpose — see the file header.
      let purged = 0;
      if (previousHead !== null && previousHead !== version.sourceVersionId) {
        const removed = await sink.purge([{ sourceId, sourceVersionId: previousHead }]);
        purged = removed.length;
        chunksPurged += purged;
      }

      outcomes.push({
        sourceId,
        // `appended.outcome` is "created" or "restored" here: the identical-bytes case returned
        // above, which is the only way the corpus reports "unchanged" or "acl-changed".
        disposition: wasAdded ? "added" : "modified",
        chunks: stored.length,
        embedded: texts.length - embedded.cacheHits,
        reused: embedded.cacheHits,
        purged,
        error: null,
      });
    } catch (error) {
      // One bad source fails alone (PRD 4.5). The loop continues, the corpus is untouched for this
      // source, and the failure is reported rather than thrown — a batch that aborts on the first
      // bad document makes every other document hostage to the worst one in the crawl.
      outcomes.push({ ...blank(sourceId, "failed"), error: messageOf(error) });
    }
  }

  for (const sourceId of changes.deleted) {
    try {
      const tombstone = store.delete({
        sourceId,
        at: listing.observedAt,
        orderedBy: run.orderedBy,
        reason:
          `absent from a complete listing by connector "${listing.connector}" at ` +
          listing.observedAt,
      });

      const removed = await sink.purge(tombstone.purge);
      chunksPurged += removed.length;

      // Every cache keyed on it (PRD 4.2). The key is derived from the text, which is why `purge`
      // hands back what it removed rather than a count.
      for (const entry of removed) {
        run.cache?.delete(embeddingCacheKey(gateway.model, entry.text));
        cacheEvictions += 1;
      }

      outcomes.push({ ...blank(sourceId, "deleted"), purged: removed.length });
    } catch (error) {
      outcomes.push({ ...blank(sourceId, "failed"), error: messageOf(error) });
    }
  }

  return {
    connector: listing.connector,
    observedAt: listing.observedAt,
    changes,
    outcomes,
    fetched,
    parsed,
    modelCalls,
    chunksWritten,
    chunksPurged,
    cacheEvictions,
    embeddingTokens,
    failures: outcomes.filter((outcome) => outcome.disposition === "failed"),
    deletionsWithheld: changes.deletionsWithheld,
  };
}

function blank(sourceId: SourceId, disposition: Disposition): SourceOutcome {
  return { sourceId, disposition, chunks: 0, embedded: 0, reused: 0, purged: 0, error: null };
}

/**
 * The post-delete probe PRD 4.2 requires, run against the sink and the cache together.
 *
 * Returns the identifiers that are still reachable, so a caller gets the evidence rather than a
 * boolean. A probe that answered "clean" without being able to say what it looked for is not a
 * probe, it is a reassurance.
 */
export async function probeRemoved(input: {
  readonly sink: ChunkSink;
  readonly chunkIds: readonly ChunkId[];
  readonly cache?: EmbeddingCache;
  readonly cacheKeys?: readonly string[];
}): Promise<{ readonly inIndex: readonly ChunkId[]; readonly inCache: readonly string[] }> {
  const inIndex: ChunkId[] = [];
  for (const chunkId of input.chunkIds) {
    if ((await input.sink.get(chunkId)) !== null) inIndex.push(chunkId);
  }

  const inCache = (input.cacheKeys ?? []).filter((key) => input.cache?.get(key) !== undefined);
  return { inIndex, inCache };
}

/** Every version a source has ever held, as references a purge or a probe can take. */
export function versionsOf(store: CorpusStore, sourceId: SourceId): readonly VersionRef[] {
  const state = store.state(sourceId);
  if (state === null) return [];
  return state.versions.map((version: { sourceVersionId: SourceVersionId }) => ({
    sourceId,
    sourceVersionId: version.sourceVersionId,
  }));
}
