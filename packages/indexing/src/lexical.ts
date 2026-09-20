/**
 * The lexical index adapter (PRD 5.2, 6.2, 6.4).
 *
 * BM25 over the group-partitioned store, which means the interesting decision in this file is not
 * the scoring function but **which documents the scoring function gets to see**.
 *
 * **Term statistics are computed over what the principal can read** (ADR 0004). BM25's IDF depends
 * on how many documents contain a term, and computing that over the whole corpus would let
 * documents the principal cannot read change the ordering of the ones they can — the same leak PRD
 * 6.2 rejects post-filtering for, arriving through a statistic instead of through a row. The cost
 * is that scores are not comparable between principals and that the statistics are recomputed per
 * query rather than maintained globally. Both are accepted; the ADR says why.
 *
 * The constants are the standard BM25 defaults. They are **not tuned**, because tuning them would
 * require a measurement this repository has not made, and a number chosen because it looked right
 * is exactly what PRD section 0 forbids.
 */

import type { ChunkId, ExistencePolicy } from "@atlasops/contracts";
import type { VersionRef } from "@atlasops/corpus";

import { rowStore } from "./partition.js";
import type { CompiledPredicate } from "./predicate.js";
import { rankBy, tokenise, type Candidate, type IndexRow } from "./row.js";
import type { IndexSchema } from "./schema.js";

/** Term-frequency saturation. The standard default; not tuned against any measurement. */
const K1 = 1.2;
/** Length normalisation. The standard default; not tuned against any measurement. */
const B = 0.75;

export interface LexicalSearch {
  readonly query: string;
  readonly predicate: CompiledPredicate;
  readonly limit: number;
}

/**
 * The answer to PRD 6.4's question, and nothing more.
 *
 * It carries counts and existence policies. It deliberately carries no identifier, no text and no
 * score, because the caller's only legitimate use is choosing abstention wording — and a probe that
 * returned anything rankable would be the post-filter this package exists to avoid, wearing a
 * different name.
 */
export interface ExistenceProbe {
  /** Matching material in `visible` sources the principal cannot read. */
  readonly visibleWithheld: number;
  /** The policies that excluded something, sorted. Feeds governance's `outcomeFor`. */
  readonly excluded: readonly ExistencePolicy[];
}

export interface LexicalIndex {
  readonly schema: IndexSchema;
  readonly upsert: (rows: readonly IndexRow[]) => Promise<void>;
  readonly purge: (refs: readonly VersionRef[]) => Promise<readonly IndexRow[]>;
  readonly search: (request: LexicalSearch) => Promise<readonly Candidate[]>;
  /** PRD 6.4's existence probe. Separately named so its use is visible in review. */
  readonly probeWithheld: (request: LexicalSearch) => Promise<ExistenceProbe>;
  readonly lastScan: () => readonly ChunkId[];
  readonly size: () => number;
}

export function inMemoryLexicalIndex(schema: IndexSchema): LexicalIndex {
  const store = rowStore();

  return {
    schema,

    upsert: (rows: readonly IndexRow[]): Promise<void> => {
      store.upsert(rows);
      return Promise.resolve();
    },

    purge: (refs: readonly VersionRef[]): Promise<readonly IndexRow[]> =>
      Promise.resolve(store.purge(refs)),

    search(request: LexicalSearch): Promise<readonly Candidate[]> {
      const terms = tokenise(request.query);
      // `visible` is the only read path, so candidate generation begins already filtered.
      const visible = store.visible(request.predicate);
      if (terms.length === 0 || visible.length === 0) return Promise.resolve([]);

      const documents = visible.map((row) => ({ row, tokens: tokenise(row.text) }));
      const count = documents.length;
      const averageLength =
        documents.reduce((sum, document) => sum + document.tokens.length, 0) / count;

      const documentFrequency = new Map<string, number>();
      for (const document of documents) {
        for (const term of new Set(document.tokens)) {
          documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
      }

      const scored = documents.map((document) => {
        let score = 0;
        for (const term of terms) {
          const frequency = document.tokens.filter((token) => token === term).length;
          if (frequency === 0) continue;

          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
          const normalisation =
            frequency + K1 * (1 - B + (B * document.tokens.length) / averageLength);
          score += idf * ((frequency * (K1 + 1)) / normalisation);
        }
        return { row: document.row, score };
      });

      // A zero score means the passage contains none of the query terms. Returning it to fill the
      // limit would put irrelevant material in front of a reranker and, eventually, in a prompt.
      return Promise.resolve(
        rankBy(
          scored.filter((entry) => entry.score > 0),
          request.limit,
        ),
      );
    },

    probeWithheld(request: LexicalSearch): Promise<ExistenceProbe> {
      const terms = new Set(tokenise(request.query));
      if (terms.size === 0) return Promise.resolve({ visibleWithheld: 0, excluded: [] });

      // Term presence, not a score. Deliberately coarse: the question is whether the query "would
      // have been answerable" from withheld material, and answering it precisely would mean
      // ranking content the principal cannot read.
      const matching = store
        .withheldForExistenceProbe(request.predicate)
        .filter((row) => tokenise(row.text).some((token) => terms.has(token)));

      const excluded = [...new Set(matching.map((row) => row.chunk.acl.existence))].sort();

      return Promise.resolve({
        visibleWithheld: matching.filter((row) => row.chunk.acl.existence === "visible").length,
        excluded,
      });
    },

    lastScan: (): readonly ChunkId[] => store.lastScan(),
    size: (): number => store.size(),
  };
}
