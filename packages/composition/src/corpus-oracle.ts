/**
 * The other half of "they communicate through the corpus store" (PRD 10, 5.5).
 *
 * `retrieval` declares a `VersionOracle` because it may not import `corpus` — the layer that
 * decides what is current must not be reachable from the layer that ranks, or "is this the live
 * version" becomes a question ranking code answers for itself. This is the implementation, and this
 * package is the layer allowed to hold it.
 *
 * It reads the corpus on every call rather than caching a snapshot. A cached view of what is
 * current is a window during which retrieval cites a superseded revision as current, and PRD 5.5
 * names that as the specific thing AtlasOps must not do. The cost is a lookup per candidate, which
 * is a map read against the in-memory store and an indexed read against a real one — and if that
 * ever becomes the bottleneck, the answer is a store that answers the question quickly, not a
 * retrieval layer that assumes.
 */

import type { SourceId, SourceVersionId } from "@atlasops/contracts";
import { versionAsOf, type CorpusStore } from "@atlasops/corpus";
import type { VersionOracle } from "@atlasops/retrieval";

export function corpusVersionOracle(store: CorpusStore): VersionOracle {
  return {
    isCurrent: (sourceId: SourceId, sourceVersionId: SourceVersionId): boolean => {
      // `liveVersion` returns null for a deleted source as well as an unknown one, so a tombstoned
      // source stops being retrievable here without this file knowing what a tombstone is.
      const live = store.liveVersion(sourceId);
      return live !== null && live.sourceVersionId === sourceVersionId;
    },

    wasCurrentAt: (
      sourceId: SourceId,
      sourceVersionId: SourceVersionId,
      instant: string,
    ): boolean => versionAsOf(store, sourceId, instant)?.sourceVersionId === sourceVersionId,
  };
}
