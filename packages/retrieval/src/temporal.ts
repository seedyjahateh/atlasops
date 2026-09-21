/**
 * Freshness and superseded sources (PRD 5.5).
 *
 * "Retrieval filters to the current version of each source by default. A chunk from a superseded
 * version is retrievable only when the query carries an explicit temporal scope."
 *
 * **Retrieval cannot import `corpus`** — its row in PRD 11.2 does not list it, and that is
 * deliberate: the layer that decides what is current must not be reachable from the layer that
 * ranks, or "is this the live version" becomes a question ranking code can answer for itself. So
 * retrieval declares the question as a port and an application answers it from the corpus, the same
 * way `ingest` declares a sink rather than importing an index.
 *
 * The default is the restrictive one. A scope that had to be supplied to *exclude* superseded
 * revisions would mean every caller who forgot it cites a policy that was replaced — which PRD 5.5
 * names as the specific thing AtlasOps must not do.
 */

import {
  AtlasOpsError,
  requireInstant,
  type SourceId,
  type SourceVersionId,
} from "@atlasops/contracts";

export type TemporalScope =
  /** The default. Only the current version of each source is retrievable. */
  | { readonly kind: "current" }
  /**
   * An explicit temporal scope: what was current at this instant.
   *
   * A deliberately narrow subset of RAG-13's subject. It answers "what did this say in March", and
   * it does not attempt full temporal query semantics.
   */
  | { readonly kind: "as-of"; readonly instant: string };

export interface VersionOracle {
  readonly isCurrent: (sourceId: SourceId, sourceVersionId: SourceVersionId) => boolean;
  readonly wasCurrentAt: (
    sourceId: SourceId,
    sourceVersionId: SourceVersionId,
    instant: string,
  ) => boolean;
}

export function requireScope(scope: TemporalScope): TemporalScope {
  if (scope.kind === "as-of") requireInstant(scope.instant, "temporal.instant");
  return scope;
}

/** Whether a candidate's version is retrievable under this scope. */
export function admits(
  oracle: VersionOracle,
  scope: TemporalScope,
  sourceId: SourceId,
  sourceVersionId: SourceVersionId,
): boolean {
  return scope.kind === "current"
    ? oracle.isCurrent(sourceId, sourceVersionId)
    : oracle.wasCurrentAt(sourceId, sourceVersionId, scope.instant);
}

export interface VersionWindow {
  readonly versionId: string;
  /** Absent means "since before anything anybody will ask about". */
  readonly from?: string;
  /** Absent means "still current". Exclusive: the successor starts at this instant. */
  readonly until?: string;
}

export interface StaticOracleInput {
  /** The current version of each source. */
  readonly current: Readonly<Record<string, string>>;
  /** Per source, the versions it has held and when each was current. */
  readonly history?: Readonly<Record<string, readonly VersionWindow[]>>;
}

/**
 * The deterministic in-repo oracle.
 *
 * History is recorded **per source** rather than per version. A version identifier is the hash of
 * its bytes, so two sources holding identical content share one (ADR 0003) — a lookup keyed on the
 * version alone would cheerfully answer for the wrong document.
 */
export function staticVersionOracle(input: StaticOracleInput): VersionOracle {
  const history = input.history ?? {};

  return {
    isCurrent: (sourceId: SourceId, sourceVersionId: SourceVersionId): boolean =>
      input.current[sourceId] === sourceVersionId,

    wasCurrentAt: (
      sourceId: SourceId,
      sourceVersionId: SourceVersionId,
      instant: string,
    ): boolean => {
      const at = Date.parse(instant);
      if (Number.isNaN(at)) {
        throw new AtlasOpsError("VALIDATION", `"${instant}" is not an instant`, "temporal.instant");
      }

      const windows = history[sourceId];
      if (windows === undefined) {
        // No history recorded for this source: the only thing that can be asserted is what is
        // current now. Guessing that it was also current in March is exactly the claim PRD 5.5
        // forbids, so an unrecorded past is not retrievable.
        return input.current[sourceId] === sourceVersionId;
      }

      const window = windows.find((entry) => entry.versionId === sourceVersionId);
      if (window === undefined) return false;
      if (window.from !== undefined && Date.parse(window.from) > at) return false;
      if (window.until !== undefined && Date.parse(window.until) <= at) return false;
      return true;
    },
  };
}
