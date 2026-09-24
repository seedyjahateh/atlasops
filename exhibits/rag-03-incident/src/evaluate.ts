/**
 * RAG-03's evaluation: section-keyed labels, resolved, then scored by `evalkit`.
 *
 * RAG-02 does something similar with symbol-keyed labels, and the two are deliberately not shared.
 * What they have in common — scoring recall and MRR over resolved labels — already lives in a
 * package, `evalkit`, and both call it. What differs is what a label *means*: a symbol in a source
 * file, or a section of a runbook. A shared "resolve a label" helper would have to know both, which
 * is two exhibits' concerns leaking into one package. PRD 11.2 promotes what two consumers need; it
 * does not merge what two consumers happen to write similarly.
 *
 * `sandbox.chunks.all()` is unfiltered and is used here only to resolve labels to identifiers —
 * never to answer a principal. The ranking being scored comes through the pre-filter.
 */

import { readFileSync } from "node:fs";

import { meanReciprocalRank, recallAt, type RelevanceItem } from "@atlasops/evalkit";

import type { IncidentAssistant } from "./assistant.js";
import { displayPathOf } from "./metadata.js";

export interface SectionLabel {
  readonly path: string;
  readonly section: string;
  readonly grade: number;
}

export interface IncidentItem {
  readonly id: string;
  readonly principal: string;
  readonly query: string;
  readonly relevant: readonly SectionLabel[];
}

export interface IncidentDataset {
  readonly id: string;
  readonly version: string;
  readonly items: readonly IncidentItem[];
}

export function loadIncidentDataset(path: string): IncidentDataset {
  const raw = JSON.parse(readFileSync(path, "utf8")) as IncidentDataset;
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error(`${path} has no items. An empty dataset scores perfectly on everything.`);
  }
  return raw;
}

export async function resolveIncidentItems(
  dataset: IncidentDataset,
  assistant: IncidentAssistant,
): Promise<RelevanceItem[]> {
  const chunks = await assistant.sandbox.chunks.all();

  return dataset.items.map((item) => {
    const judgments: Record<string, number> = {};
    for (const label of item.relevant) {
      const matching = chunks.filter(
        (stored) =>
          displayPathOf(stored.chunk.sourceId) === label.path &&
          stored.chunk.headingPath.at(-1) === label.section,
      );
      if (matching.length === 0) {
        throw new Error(
          `${item.id} labels ${label.path}#${label.section}, and no chunk carries that section. ` +
            `Renamed or removed: fix the label rather than let it score zero.`,
        );
      }
      for (const stored of matching) {
        judgments[stored.chunk.chunkId] = Math.max(
          judgments[stored.chunk.chunkId] ?? 0,
          label.grade,
        );
      }
    }
    return {
      id: item.id,
      split: "development",
      query: item.query,
      principal: item.principal,
      judgments,
    };
  });
}

export interface IncidentScores {
  readonly recallAt5: number;
  readonly mrr: number;
  readonly items: number;
  readonly unscorable: readonly string[];
}

export async function evaluateIncident(
  dataset: IncidentDataset,
  assistant: IncidentAssistant,
): Promise<IncidentScores> {
  const resolved = await resolveIncidentItems(dataset, assistant);
  const scorable = resolved.filter((item) => Object.keys(item.judgments).length > 0);
  const unscorable = resolved.filter((item) => Object.keys(item.judgments).length === 0);

  const ranked = await Promise.all(
    scorable.map(async (item) => ({
      itemId: item.id,
      ranked: await assistant.ranked(item.principal, item.query),
    })),
  );

  return {
    recallAt5: recallAt(5, scorable, ranked).value,
    mrr: meanReciprocalRank(scorable, ranked).value,
    items: scorable.length,
    unscorable: unscorable.map((item) => item.id),
  };
}
