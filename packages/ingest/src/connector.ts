/**
 * The connector port (PRD 4.2).
 *
 * **Listing and fetching are separate calls, and that separation is the budget.** PRD 4.2 requires
 * an unchanged source to cost one hash comparison rather than a parse-and-embed cycle, which is
 * only achievable if the pipeline can decide whether to fetch content *before* it has any. A
 * connector that returned bodies from `list` would make the unchanged case cost the same as the
 * changed one, and no amount of care further down would recover it.
 *
 * `strategy` lives on the connector because PRD 4.3 keeps fixed-width chunking available "for
 * sources with no recoverable structure, selected per connector rather than globally". A wiki
 * connector and a scanned-PDF connector want different answers, and a global setting forces the
 * worse one on both.
 */

import type { ConnectorListing, SourceObservation } from "@atlasops/corpus";
import type { SourceId } from "@atlasops/contracts";

import type { ChunkStrategy } from "./strategy.js";

export interface FetchedSource {
  readonly observation: SourceObservation;
  /** The bytes. `observation.contentHash` must be their hash; the pipeline checks it. */
  readonly text: string;
}

export interface Connector {
  readonly name: string;
  /** Identity, content hash and access label. No content — see the file header. */
  readonly list: () => Promise<ConnectorListing>;
  readonly fetch: (sourceId: SourceId) => Promise<FetchedSource>;
  readonly strategy: ChunkStrategy;
}
