/**
 * The ingestion pipeline (PRD 10, 4.2).
 *
 * "They share the internal packages described next and communicate through the corpus store and the
 * indexes rather than through direct calls, so that a stalled ingestion job degrades corpus
 * freshness without degrading answer latency."
 *
 * That sentence is the whole design, and the thing worth noticing is what this file does **not**
 * export: any way for an answer to wait on an ingestion. There is no queue an answer drains, no
 * lock an answer acquires, no handle an answer holds. The two pipelines meet at the corpus store
 * and the indexes and nowhere else, so a crawl that hangs forever makes the corpus stale — which is
 * a real cost, and a different cost from a request timing out.
 *
 * The test for that lives in `composition.test.ts` and works the only way this can honestly be
 * shown: start an ingestion that never settles, answer queries while it is in flight, and assert
 * that every answer completes with the latency it would have had anyway.
 */

import { ingest, type IngestionReport } from "@atlasops/ingest";
import type { Principal } from "@atlasops/governance";

import type { IngestionPorts } from "./ports.js";

export interface IngestionPipeline {
  readonly connector: string;
  /** One crawl. Returns a report; throws only on a failure the corpus could not isolate. */
  readonly run: () => Promise<IngestionReport>;
}

export interface IngestionPipelineOptions {
  /**
   * Who a crawl-detected deletion is attributed to.
   *
   * Required, because the corpus refuses an unattributed deletion and a worker with no identity
   * would have to invent one at the moment it mattered.
   */
  readonly orderedBy: Principal;
}

export function createIngestionPipeline(
  ports: IngestionPorts,
  options: IngestionPipelineOptions,
): IngestionPipeline {
  return {
    connector: ports.connector.name,

    run: (): Promise<IngestionReport> =>
      ingest({
        connector: ports.connector,
        store: ports.store,
        gateway: ports.embeddings,
        sink: ports.chunks,
        orderedBy: options.orderedBy,
        ...(ports.embeddingCache === undefined ? {} : { cache: ports.embeddingCache }),
        ...(ports.tokenCounter === undefined ? {} : { tokenCounter: ports.tokenCounter }),
      }),
  };
}
