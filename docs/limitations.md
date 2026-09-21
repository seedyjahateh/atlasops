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

## Four more this build actually has

**No provider adapter is installed.** PRD 5 puts embedding, reranking and generation behind
`model-gateway`'s interfaces. The interfaces exist and so do deterministic in-repo stand-ins; no
adapter for any vendor does. Every model identifier these processes record says so —
`stand-in-embedder`, `stand-in-reranker`, `stand-in-not-a-model`, `stand-in-judge`.

Two consequences follow, and they are the most important sentences in this document:

- **The stand-in embedder has no semantic structure.** It derives a vector from a hash, so cosine
  similarity between an unrelated query and a passage is noise rather than zero. The dense arm
  returns candidates for queries the corpus cannot answer, and the API answers almost anything with
  something. There is a test asserting exactly that (`api.test.ts`), because a limitation with a
  test is a fact and a limitation in a document is a hope.
- **The stand-in generator does no language modelling.** It cites the first passage it was shown and
  quotes its opening. That exercises prompt assembly, citation binding and the verification pass for
  real, and produces prose nobody should read as an answer.

**No number in this repository is a retrieval-quality result.** Every metric `evalkit` can compute
has been computed, and every one of them measures stand-ins. The single exception is the governance
artefact: a leak count measures the permission pre-filter, which is ordinary code with no model in
it, so that number is about the system that ships.

**Cost is unmeasurable, not zero.** The price table ships empty (ADR 0002), because real vendor
prices are facts this repository does not hold. An unpriced model throws rather than costing zero,
so `ingestionCostPer1kChunks` refuses, the audit record carries `costUsd: null`, and the evaluation
report's cost row says it could not be measured. A reader can tell "this cost nothing" from "nobody
knows what this cost"; a zero cannot.

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
