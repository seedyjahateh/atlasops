# Limitations

PRD 12 item 7 requires an honest limitations list, and names four it expects to see: the synthetic
corpus, the English-only v1, the absence of real user traffic, and judge-model bias in groundedness
metrics. All four are here. So are three more that this build has and the PRD did not anticipate,
because a list that only contains the limitations somebody else predicted is not an honest list.

This text is the source for `content.limitations` when the manifest is eventually promoted. It is
not promotion; see `promotion-readiness.md`.

---

## The four PRD 12 names

**The corpus is synthetic.** Every corpus in this repository — `examples/corpus`, the ingest and
parser fixtures, the evaluation datasets — was written to exercise the code. Metrics computed over
it measure the corpus at least as much as the system, and its adversarial subpopulations are the
ones we thought to write rather than the ones users produce. PRD 13 accepts this as unavoidable
without real user data and asks that the construction procedure be published; the fixtures carry
their construction rationale in their own `$comment` fields, including why the evaluation corpus is
sized as it is.

**English only.** Chunking, stopword removal and the lexical analyser assume English. The stopword
list is a conventional English one, not tuned and not language-detected. A corpus in another
language needs its own list, and that is a per-connector decision the way chunking strategy is.
Nothing detects a mismatch, so a non-English corpus would ingest and retrieve badly rather than
loudly.

**No real user traffic.** Every measurement in this repository is synthetic in `telemetry`'s literal
sense — the flag is `true` by default and nothing here has ever set it to `false`. No query in any
dataset came from a person trying to get work done, and the distribution of real questions is the
thing none of this has seen.

**Judged metrics carry the judge's bias.** Groundedness and contradiction cannot be computed by
string matching, so they need a judge, and a judge introduces a bias that can be mistaken for a
quality improvement — particularly when the judge and the generator share a family. PRD 8.3's three
controls are implemented: the judge is pinned by model identifier and prompt version, judge-human
agreement is returned alongside the judged metrics and cannot be obtained separately, and a judged
improvement beside a retrieval regression is reported as a regression. The controls constrain the
bias; they do not remove it.

---

## What this build actually has, beyond PRD 12's four

**Real models have run, in two of the four roles.** Since P18b the published
evaluation (`docs/evidence/run-*.json`) and load run (`docs/measurements/load-run.json`) used
`text-embedding-3-small` and `gpt-4.1-mini`, priced from the dated table `openai-2026-09-24`. Two
roles are still stand-ins, and each limits what the numbers mean:

- **The reranker is the unselected stand-in, and with real embeddings it makes ranking worse.**
  OpenAI publishes no rerank model (ADR 0006), so none is selected. With stand-ins everywhere it was
  harmless; with real embeddings the ablation shows the **served configuration,
  `fused-with-rerank`, is the worst of the fused arms**: nDCG@10 **0.71**, against **0.87** with
  reranking bypassed and **0.95** dense-only. The served default was deliberately not changed in the
  evidence phase — choosing a configuration on eleven development items and then quoting those
  items would be overfitting. **The held-out split points the same way** (P19b,
  `docs/evidence/held-out/retrieval-by-split.md`): nDCG@10 **0.64** served, **0.77** with
  reranking bypassed, **0.82** dense-only. That is three items, and bypassing wins on two of them,
  so it says which way to lean rather than by how much. The served default is still unchanged:
  choosing it is a person's decision.
- **The judge is a stand-in**, so the groundedness rows (supported-claim rate, contradiction rate,
  judge-human agreement) are not quality evidence, whatever they read. PRD 8.3 does not let a judged
  metric gate a release alone, and here it cannot inform one either.

What the real run established, and which stand-ins never could: **correct-abstention 1.0 over 4**
(it was 0 with the stand-in generator), citation precision and recall 0.83 on the served arm,
span-validity 1.0, and **zero leaks and zero existence disclosures with real models in the loop**.
Each is over a small development split labelled by the author of the corpus, and says so.

**Cost is measured, with two qualifications.** Cost per answered query is p50 **$0.00082** and p95
**$0.00172**, and ingestion costs $0.001 per thousand chunks — all far inside PRD 9.3. Every figure
**excludes reranking**, because the reranker is a local stand-in nothing bills for; a selected rerank
model would add its own price. And the evaluation report's own cost row counts generation only — the
load run is the whole-request figure, since P18a priced the query embedding on the retrieval span
and the harness row predates that.

**The answer path is close to its latency budget, and over it without the cache.** End-to-end p95 is
**2,914 ms** against 3,000 — but 247 of the 260 requests were served from the retrieval cache. The
thirteen cache misses have a p95 of **3,597 ms, over budget**; with thirteen samples that is the
slowest one. Generation is almost the whole of it. The run was also throttled by this account's
rate limit (200,000 tokens per minute) at concurrency 4, and the waits are inside the figures; how
many requests waited is not in the export.

**Generation failures degrade, and an evaluation leaves the degraded queries out.** Since ADR 0010,
a model failure in generation returns the ranked passages with no prose (PRD 9.4) instead of
aborting the request. It took two aborted real evaluations to get there: one transient failure in
P18b, and one answer that hit the 800-token output limit in the first held-out run. An evaluation
now completes, marks those queries degraded in its per-query file, and leaves them out of the
citation, groundedness and abstention metrics — so a run with many of them reports on fewer items,
and its sample sizes say so. The load harness counts a degraded answer as an abstention, and its
record does not yet export how many there were.

**Time to first token is unmeasurable.** PRD 9.3 names streaming instrumentation as the method, and
streaming is not implemented: the adapter speaks the non-streaming endpoint (ADR 0006).

The stand-ins remain the **default** for every command, and everything below about them still holds
for any run that uses them:

- **The stand-in embedder has no semantic structure.** It derives a vector from a hash, so cosine
  similarity between an unrelated query and a passage is noise rather than zero. There is a test
  asserting what that does (`api.test.ts`), because a limitation with a test is a fact and a
  limitation in a document is a hope.
- **The stand-in generator does no language modelling**, and with it correct-abstention was 0 over 4:
  every passage looks equally relevant, so the support threshold never decides anything.

**No persistent storage adapter exists.** The only store profile is `memory`, in-process. Four
components in four processes therefore cannot share a corpus, which is why the API and the
evaluation runner crawl one themselves rather than reading what the worker wrote. PRD 10 has these
components communicating through the corpus store and the indexes; with a persistent profile they
would, and the composition root would not change. Both applications refuse any other profile by
name rather than falling back.

---

## Scope boundaries, which are choices rather than gaps

These are places where the PRD deliberately drew a line, recorded here so that a reader does not
mistake a decision for an oversight.

- **Semantic chunking is not implemented.** PRD 4.3 assigns it to RAG-09; adopting it here without
  measurement would be the unevidenced choice this project exists to avoid.
- **Verification is structural, not entailment-based.** PRD 7.2's floor: identifiers, membership,
  permission and offsets, all decidable. Scored entailment over decomposed claims is RAG-15.
- **Temporal queries are a narrow subset.** PRD 5.5: retrieval filters to the current version and
  an `as-of` scope answers "what did this say in March". Full temporal semantics is RAG-13. An
  `as-of` query is also only answerable over an index configured to retain superseded versions,
  which the default retention does not do.
- **Query expansion and multi-query generation are absent**, by PRD 5.4's instruction that they
  belong in the evaluation harness as an arm before they belong in the default path.
- **Stemming is absent** although PRD 5.4 lists it, and this one is a correctness judgement rather
  than a deferral: a stemmer must run identically at index time and query time, and `indexing`
  tokenises documents without one, so stemming only the query would match nothing.
- **`k`, the retriever depths, the support threshold and the regression tolerance are unselected.**
  They carry `provenance: "unselected-default"` and every result records it. PRD 5.2 requires them
  to be selected on the labelled development split and recorded in an evaluation artefact, and that
  selection has not been run.
