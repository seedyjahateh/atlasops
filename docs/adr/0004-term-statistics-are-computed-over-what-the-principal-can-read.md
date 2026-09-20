# ADR 0004 — Term statistics are computed over what the principal can read

- **Status:** accepted
- **Phase:** P7 (`packages/indexing`)
- **Specification:** PRD 5.2, 6.2

## Context

PRD 6.2 requires the permission predicate to be applied during candidate generation, and rejects
post-filtering. One of its four stated reasons is that a forbidden document which reached the
reranker "has already influenced the relative ordering of everything else in the batch."

BM25 has the same property one layer earlier, and it is easy to miss because no forbidden row is
returned. Its inverse document frequency term is a function of how many documents in the collection
contain a word. If that count is taken over the whole corpus, then a term that is common in
documents the principal cannot read is scored as common for them too — and the ordering of the
documents they _can_ read shifts because of documents they cannot. No row leaks, and the ranking
still carries information about the hidden part of the corpus.

The effect is small on a large corpus and large exactly where it matters: a tenant whose readable
subset is small, a term that is rare overall and common inside one restricted collection.

## Decision

**IDF and average document length are computed over the rows the compiled predicate makes visible,
per query.**

The partitioned store returns the visible set, and the lexical adapter derives its collection size,
average length and document frequencies from that set and nothing else. No corpus-wide statistic is
maintained, so there is none to accidentally consult.

## Consequences

Scores are not comparable between principals. Two people running the same query against the same
document get different numbers for it, and any evaluation that aggregates raw scores across
principals is meaningless. Ranks within one principal's result set remain perfectly comparable,
which is what fusion in PRD 5.3 and the metrics in PRD 8.2 actually consume — they are rank-based,
not score-based, and that is now load-bearing rather than incidental.

Statistics are recomputed per query instead of being maintained incrementally. On the in-memory
adapter this costs one pass over the visible set, which is the pass candidate generation makes
anyway. On a real index it is the harder half of this decision: a production lexical engine
maintains global statistics precisely because recomputing them is expensive, and an adapter for one
has to either maintain per-group statistics or accept an approximation. An approximation is
acceptable here in a way it is not for the row filter — a slightly wrong IDF changes an ordering,
whereas a slightly wrong filter returns a document — but the adapter must say which it does.

The alternative, corpus-wide statistics with a note in the documentation, was rejected for the same
reason PRD 6.2 rejects post-filtering: it is correct in every test anybody writes, and wrong in the
case the system exists to get right.
