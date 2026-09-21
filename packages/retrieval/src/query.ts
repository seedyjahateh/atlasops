/**
 * Query handling (PRD 5.4).
 *
 * "The lexical arm additionally receives the query with source-language analysis applied
 * (lowercasing, stemming, stopword handling) while the dense arm receives the raw query, because
 * the two retrievers want different preprocessing and sharing one pipeline degrades both."
 *
 * Two of those three are done here. **Stemming is deliberately not**, and the reason is not
 * effort — applying it here would make retrieval worse. A stemmer has to run identically over the
 * documents at index time and over the query at search time; stemming only the query turns
 * `policies` into `polici` and matches nothing, because `indexing` tokenises documents without
 * stemming. The analyzer belongs to the lexical engine, beside the tokeniser that built the
 * postings, and a stemmer added on this side alone is a recall regression dressed as an
 * improvement.
 *
 * Lowercasing is safe asymmetrically because `indexing`'s tokeniser already lowercases. Stopword
 * removal is safe because it only removes terms, and a term BM25 would have scored near zero
 * anyway — it cannot introduce a match that should not exist.
 *
 * Query expansion and multi-query generation are absent by PRD 5.4's instruction: they belong in
 * the evaluation harness as an arm before they belong in the default path.
 */

import { contentHashOf, type ContentHash } from "@atlasops/contracts";

/**
 * A small, conventional English stopword list.
 *
 * Not tuned, not measured, and not language-detected. A corpus in another language needs its own
 * list, and that is a per-connector decision the way chunking strategy is.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export interface AnalysedQuery {
  readonly raw: string;
  /** Whitespace-collapsed and trimmed. What the dense arm embeds. */
  readonly normalised: string;
  /** Lowercased, stopworded. What the lexical arm searches. */
  readonly lexical: string;
  /** Of the normalised form, for the audit record and every cache key (PRD 6.3, 6.6). */
  readonly hash: ContentHash;
}

export function analyseQuery(raw: string): AnalysedQuery {
  const normalised = raw.replace(/\s+/g, " ").trim();

  const terms = normalised
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));

  // A query that is entirely stopwords keeps its terms rather than becoming empty. "How do I do
  // it" is a bad query, and returning nothing for it is a different failure from returning
  // nothing because the corpus has no answer — the second is honest, the first is a bug.
  const lexical =
    terms.length > 0
      ? terms.join(" ")
      : normalised
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((token) => token.length > 0)
          .join(" ");

  return { raw, normalised, lexical, hash: contentHashOf(normalised) };
}
