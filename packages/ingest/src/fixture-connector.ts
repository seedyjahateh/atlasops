/**
 * The deterministic in-repo connector.
 *
 * Every test above this line runs against it: no network, no filesystem watching, no clock. It is
 * also the fault-injection harness for PRD 4.5's "one bad source fails alone" row — a connector
 * that can be told to fail on a named source is the only honest way to test isolation, because the
 * alternative is mocking the pipeline's own internals and asserting that the mock was called.
 *
 * It counts its own `fetch` calls. That counter is the evidence for PRD 4.2's unchanged-source
 * budget: the pipeline can claim it did not parse anything, but the connector can prove nothing was
 * ever asked for.
 */

import { contentHashOf, type SourceId } from "@atlasops/contracts";
import type { ConnectorListing, SourceObservation } from "@atlasops/corpus";

import type { Connector, FetchedSource } from "./connector.js";
import type { ChunkStrategy } from "./strategy.js";

export interface FixtureSource {
  readonly sourceId: SourceId;
  readonly text: string;
  /** Overrides the connector's default label for this source. */
  readonly acl?: unknown;
}

export interface FixtureConnectorOptions {
  readonly name?: string;
  readonly strategy: ChunkStrategy;
  readonly sources: readonly FixtureSource[];
  readonly observedAt: string;
  /** The label every source carries unless it overrides it. */
  readonly acl: unknown;
  /** False models a paged or partial crawl, which must not produce deletions (PRD 4.2). */
  readonly complete?: boolean;
}

export interface FixtureConnector extends Connector {
  /** How many times content was actually asked for. The unchanged-source budget's evidence. */
  readonly fetches: () => number;
  readonly resetCounters: () => void;
  /** Replace a source's text, as an upstream edit would. */
  readonly revise: (sourceId: SourceId, text: string) => void;
  /** Remove a source, as an upstream deletion would. */
  readonly remove: (sourceId: SourceId) => void;
  /** Make `fetch` throw for this source, as a permission error or a corrupt body would. */
  readonly breakSource: (sourceId: SourceId, reason?: string) => void;
  readonly observedAt: (at: string) => void;
}

export function fixtureConnector(options: FixtureConnectorOptions): FixtureConnector {
  const texts = new Map<SourceId, string>();
  const labels = new Map<SourceId, unknown>();
  const broken = new Map<SourceId, string>();
  let observedAt = options.observedAt;
  let fetches = 0;

  for (const source of options.sources) {
    texts.set(source.sourceId, source.text);
    if (source.acl !== undefined) labels.set(source.sourceId, source.acl);
  }

  const aclFor = (sourceId: SourceId): unknown => labels.get(sourceId) ?? options.acl;

  return {
    name: options.name ?? "fixture",
    strategy: options.strategy,

    list: (): Promise<ConnectorListing> =>
      Promise.resolve({
        connector: options.name ?? "fixture",
        observedAt,
        complete: options.complete ?? true,
        sources: [...texts.entries()]
          .map(([sourceId, text]) => ({ sourceId, contentHash: contentHashOf(text) }))
          .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      }),

    fetch: (sourceId: SourceId): Promise<FetchedSource> => {
      fetches += 1;

      const failure = broken.get(sourceId);
      if (failure !== undefined) return Promise.reject(new Error(failure));

      const text = texts.get(sourceId);
      if (text === undefined) {
        return Promise.reject(new Error(`the fixture holds no source ${sourceId}`));
      }

      const observation: SourceObservation = {
        sourceId,
        contentHash: contentHashOf(text),
        observedAt,
        effectiveDate: null,
        upstreamRevision: null,
        acl: aclFor(sourceId),
      };

      return Promise.resolve({ observation, text });
    },

    fetches: (): number => fetches,
    resetCounters: (): void => {
      fetches = 0;
    },
    revise: (sourceId: SourceId, text: string): void => {
      texts.set(sourceId, text);
    },
    remove: (sourceId: SourceId): void => {
      texts.delete(sourceId);
    },
    breakSource: (sourceId: SourceId, reason = "fixture fault injection"): void => {
      broken.set(sourceId, reason);
    },
    observedAt: (at: string): void => {
      observedAt = at;
    },
  };
}
