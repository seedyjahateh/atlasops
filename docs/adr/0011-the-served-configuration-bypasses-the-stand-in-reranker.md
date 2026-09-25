# ADR 0011 — The served configuration bypasses the stand-in reranker

- **Status:** accepted
- **Date:** 2026-09-25
- **Reverses:** the served default `rerank: { enabled: true }` in `RETRIEVAL_DEFAULTS`, in place
  since P7
- **Decided by:** the project owner, choosing between this and dense-only on the published
  evidence

## Context

OpenAI publishes no rerank model (ADR 0006), so the only reranker this build has is the unselected
in-repo stand-in. While every model was a stand-in, it did no visible harm. Once the embeddings were
real, it did:

- **Development split** (11 relevance items, P18b): nDCG@10 0.71 served, against 0.87 with reranking
  bypassed and 0.95 dense-only.
- **Held-out split** (3 items, P19b, `docs/evidence/held-out/retrieval-by-split.md`): 0.64 served,
  0.77 bypassed, 0.82 dense-only. Bypassing wins on two of the three.

Two changes were on the table: bypass the reranker and keep fused retrieval, or go dense-only.
Dense-only ranks higher on both splits.

## Decision

**Serve fused retrieval with reranking bypassed.** `RETRIEVAL_DEFAULTS.rerank.enabled` is `false`.
Dense-only was not chosen:

- It would drop a retriever on the strength of 14 labelled items. The evidence shows fusion
  weighted poorly on a small synthetic corpus, not that lexical retrieval is useless. On held-out
  rel-013, lexical scored 1.00 where dense scored 0.63.
- It would contradict PRD section 5, and the portfolio's description of the system, on that same
  thin evidence.
- It has no fallback. With lexical switched off, an unavailable embedder leaves nothing to serve.
  Fused retrieval degrades to lexical-only (PRD 9.4).

The reranker port stays wired, and the `fused-with-rerank` arm still evaluates it. Selecting a real
rerank model is then a configuration change.

**The served arm is derived, not named.** `servedArm(RETRIEVAL_DEFAULTS)` in `evalkit` finds the arm
whose switches match the default. The runner uses it for the comparison baseline and the governance
report, and records `served: true` on that arm's record. The readiness verdict reads the served arm
from the records, and fails item 2 unless exactly one is marked. The load run records the reranker
as `none (bypassed by the served configuration, ADR 0011)`. It reports the rerank budget unmeasured
for that reason, and stops claiming its costs exclude a reranker that never ran.

## Consequences

- **Abstention loses its score-based threshold.** PRD 7.3 defines the support threshold on reranker
  scores, and a bypassed reranker scores nothing. Null is not zero (`fusion.ts`), so the threshold
  never fires, and refusing becomes the generator's decision alone. On development this arm answered
  one of the four questions it should have refused (correct abstention 0.75). Dense-only, also
  unreranked, refused all four. This is the first thing to measure with more labelled items.
- **`fusionK` and the retriever depths remain unselected.** Tuning them is the obvious next step
  and would need a fresh held-out split, because this one has been read for this decision.
- **The rerank budget of PRD 9.3 is not measured by the served configuration.** It becomes
  measurable again the day a rerank model is selected.
- The published evaluation, load run and readiness proposal describe the new configuration. The
  portfolio manifest, promoted from the old one, needs a new reviewed edit.
