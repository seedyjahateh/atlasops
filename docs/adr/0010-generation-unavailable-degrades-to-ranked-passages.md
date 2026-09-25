# ADR 0010 — Generation unavailable degrades to ranked passages

- **Status:** accepted
- **Date:** 2026-09-25
- **Amends:** the answer contract (`ABSTENTION_REASONS`) and `GroundingResult`

## Context

PRD 9.4 lists five degraded modes. Retrieval implemented three of them in P7 — reranker, vector
index and lexical index unavailable — and permission resolution fails closed by design. The fifth
was never built: "Generation unavailable: return ranked passages with citations and no prose."

Its absence cost two real evaluations. In P18b a transient failure thrown from the answer path
aborted the first run. On 2026-09-25 the first held-out run aborted again, when one answer hit the
generator's 800-token output limit: a non-retryable `invalid-request`, raised through
`groundAnswer`, the harness and the runner, ending the whole suite with no artefact written. A
single provider failure should not be able to end a run, and in the API it ended the request with
a 500.

## Decision

1. **A `ModelError` from the generator ends generation for that request, and the answer degrades.**
   The released answer is an abstention with a new reason, `generation-unavailable`. It has no
   prose. `GroundingResult` gains `passages` — the retrieved candidates in rank order — and
   `degraded: ["generation-unavailable"]`, and the generation span is marked degraded.

2. **The decision is made at the call site, not from `error.capability`.** The adapters disagree on
   that string ("generation" in the OpenAI adapter, "generator" in the fake), and a degraded-mode
   switch that matched it would miss one of them. The grounding code knows it called the generator.
   The retry loop has already spent its budget on the kinds worth retrying.

3. **Anything that is not a `ModelError` still throws.** A bug in grounding is not an unavailable
   dependency, and degrading around it would hide it behind an answer that looks like an outage.

4. **The passages are what the caller is shown, so they are what the audit cites.** Each was
   admitted by the permission pre-filter for this principal, so the fallback shows nothing the
   answer path would not have, and the message says only that passages are being returned
   (PRD 6.4). The API returns them as `citations` with no new response field; RAG-02 cites them
   whole, at `chunk` precision.

5. **An evaluation leaves degraded queries out of the answer metrics.** In shape, a degraded answer
   is an abstention. Scored as one, it would be credited as a correct refusal on an unanswerable
   question, charged as an over-abstention on an answerable one, and score zero on citation recall
   — all for a provider outage. So the harness keeps the query in the per-query file with its
   `degraded` mark and leaves it out of the citation, groundedness and abstention metrics. The
   sample sizes shrink by the same count. Retrieval metrics still count it, because retrieval ran
   normally. If the failures remove every item of a kind the metric needs, the row reports itself
   unavailable and says why, instead of the metric throwing as it does on a malformed dataset.

## Consequences

- A run completes through provider failures, and says on its face how many queries it scored.
- A run with many degraded queries reports on fewer items. That is visible in its sample sizes, not
  hidden in its means — the cost of refusing to score an outage.
- The load harness counts a degraded answer as an abstention: it is left out of cost per answered
  query and included in latency. The load record does not yet export a degraded count.
- The output limit itself is unchanged at 800 tokens. Raising it would change a generation
  parameter, which PRD 8.5 permits only with a full evaluation, and it would not remove the next
  failure — only move it.
