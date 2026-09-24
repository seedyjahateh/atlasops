/**
 * The exhibit's evaluation: symbol-keyed labels, resolved, then scored by `evalkit`.
 *
 * The metrics are `evalkit`'s own — recall@k and MRR, the same functions the main evaluation runs —
 * which is a second piece of the reuse claim: an exhibit with its own corpus and its own dataset
 * shape still measures with the shared harness, so its numbers mean what the platform's mean.
 *
 * **Labels are resolved, and a label that resolves to nothing is an error.** A symbol that was
 * renamed or deleted would otherwise produce an empty judgment set, and recall over an empty
 * judgment set is either NaN or a vacuous 1 — both of which read as something other than "this
 * label is stale".
 */

import { readFileSync } from "node:fs";

import { meanReciprocalRank, recallAt, type RelevanceItem } from "@atlasops/evalkit";
import type { StoredChunk } from "@atlasops/ingest";

import type { Assistant } from "./assistant.js";

export interface SymbolLabel {
  readonly path: string;
  readonly symbol: string;
  readonly grade: number;
}

export interface CodebaseItem {
  readonly id: string;
  readonly principal: string;
  readonly query: string;
  readonly relevant: readonly SymbolLabel[];
}

export interface CodebaseDataset {
  readonly id: string;
  readonly version: string;
  readonly items: readonly CodebaseItem[];
}

export function loadCodebaseDataset(path: string): CodebaseDataset {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CodebaseDataset;
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error(`${path} has no items. An empty dataset scores perfectly on everything.`);
  }
  return raw;
}

/** The chunks a symbol label names. Several when an oversized symbol was split by line. */
export function chunksForSymbol(
  label: SymbolLabel,
  chunks: readonly StoredChunk[],
  versionOf: (path: string) => string | null,
): readonly string[] {
  const version = versionOf(label.path);
  if (version === null) {
    throw new Error(`the label names ${label.path}, which is not in the fixture repository`);
  }

  const matching = chunks.filter(
    (stored) =>
      stored.chunk.sourceVersionId === version &&
      stored.chunk.headingPath.some((heading) => heading.endsWith(` ${label.symbol}`)),
  );

  if (matching.length === 0) {
    throw new Error(
      `the label names ${label.path}#${label.symbol}, and no chunk carries that symbol. Renamed or ` +
        `deleted: fix the label rather than let it score zero.`,
    );
  }
  return matching.map((stored) => stored.chunk.chunkId);
}

/** Symbol labels as the chunk-keyed relevance items `evalkit` scores. */
export async function resolveItems(
  dataset: CodebaseDataset,
  assistant: Assistant,
): Promise<RelevanceItem[]> {
  const chunks = await assistant.chunks();
  return dataset.items.map((item) => {
    const judgments: Record<string, number> = {};
    for (const label of item.relevant) {
      for (const chunkId of chunksForSymbol(label, chunks, assistant.versionOf)) {
        judgments[chunkId] = Math.max(judgments[chunkId] ?? 0, label.grade);
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

export interface CodebaseScores {
  readonly recallAt5: number;
  readonly mrr: number;
  readonly items: number;
  /** Items with no readable relevant symbol, which recall cannot score and which are reported apart. */
  readonly unscorable: readonly string[];
}

export async function evaluate(
  dataset: CodebaseDataset,
  assistant: Assistant,
  rank: (principal: string, query: string) => Promise<readonly string[]>,
): Promise<CodebaseScores> {
  const resolved = await resolveItems(dataset, assistant);

  // An item whose principal may read nothing relevant is a permission case, not a retrieval one:
  // recall over an empty relevant set is undefined, and folding it in as 0 or 1 would move the
  // average for a reason that has nothing to do with ranking.
  const scorable = resolved.filter((item) => Object.keys(item.judgments).length > 0);
  const unscorable = resolved.filter((item) => Object.keys(item.judgments).length === 0);

  const ranked = await Promise.all(
    scorable.map(async (item) => ({
      itemId: item.id,
      ranked: await rank(item.principal, item.query),
    })),
  );

  return {
    recallAt5: recallAt(5, scorable, ranked).value,
    mrr: meanReciprocalRank(scorable, ranked).value,
    items: scorable.length,
    unscorable: unscorable.map((item) => item.id),
  };
}
