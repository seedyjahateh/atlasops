# AtlasOps — build phases

This file is the loop's state. One phase is implemented per iteration, in order. A phase is done
only when every acceptance item under it holds and the work is committed.

**The specification is `docs/prd/RAG-01-atlasops.md`.** The canonical copy lives at
`seedyjahateh-portfolio/docs/prd/projects/RAG-01-atlasops.md`; if the two ever disagree, the
portfolio copy wins, in the same way the project manifest wins over the PRD.

## Why this order

It is not arbitrary and it is not a preference. PRD section 11.2 declares the dependency layers:

```
contracts → telemetry → { governance, model-gateway } → corpus
          → { ingest, indexing } → retrieval → grounding → evalkit → apps
```

Dependencies flow downward only and the graph must stay acyclic, so building in any other order
means writing a module against a dependency that does not exist yet and stubbing it — which is how
the layer boundaries rot before they are ever enforced. The phase list below is that order.

## The standing bar, every phase

A phase is not done because the code exists. It is done when all of this is true:

- `pnpm verify` passes — typecheck, lint, format, test, and `boundaries:check`.
- The module declares an `exports` map and nothing outside it is reachable from another package.
- The module imports nothing its row in PRD 11.2 forbids. This is checked, not asserted.
- Public behaviour has tests. Tests assert behaviour and failure modes, not implementation detail.
- No invented data. Where a phase needs a model, an index or a clock, it takes an interface and the
  tests supply a deterministic fake. Nothing calls a paid API to pass a test.
- Anything that changes a boundary, adds a dependency, or reverses an earlier decision gets an ADR
  in `docs/adr/`, per the portfolio's own rule that a dependency without an ADR does not ship.
- The commit message explains why, not just what.

## Phases

- [x] **P0 — Foundation and boundary enforcement.** pnpm workspace, TypeScript strict, ESLint flat
      config, Vitest, Prettier, CI, `tools/boundaries` (layer manifest, generator, checker),
      CODEOWNERS. Implements PRD 11.3. Acceptance: `pnpm verify` green; `boundaries:check` fails a
      deliberately introduced illegal import and passes once removed; the module table is generated
      from `layers.json` rather than hand-maintained.

      Done. The acceptance was demonstrated rather than assumed: a real `packages/contracts`
      importing `@atlasops/telemetry` produced `forbidden-import` and exit 1, and removing it
      returned exit 0. The generated table went to `docs/MODULES.md` instead of back into the PRD —
      the PRD here is a mirror of the portfolio's canonical copy and a generator that rewrote it
      would put the two in permanent conflict. Recorded as ADR 0001.

- [x] **P1 — `packages/contracts`.** Shared types, JSON schemas, error taxonomy, identifier
      formats. Zero runtime dependencies, zero internal imports. Implements PRD 4.4 (what every
      chunk carries) and 7.1 (the answer contract). Acceptance: schemas validate a known-good and a
      known-bad fixture; identifiers round-trip; the package imports nothing.

      Done. 37 tests. Four fixtures — two good, two bad — read as untrusted JSON rather than
      imported, because that is the path real input takes. Imports are `node:crypto` in source and
      nothing else; `dependencies` is empty and the boundary checker enforces `mayImport: []`.

      Three PRD requirements were made structural rather than documented. A chunk identifier is
      derived from its version and ordinal, so re-ingestion determinism (4.5) holds by construction
      and a disagreeing id is a parse error. An ACL whose readable set is empty grants nothing, and
      an unresolvable ACL is a separate, louder failure — conflating those two is how "unknown"
      becomes "public" (6.1). And a claim segment with no references fails to parse, so an
      unsupported claim is a schema violation rather than a quality problem (7.1).

- [x] **P2 — `packages/telemetry`.** Span model, token and cost accounting, versioned price table,
      budget assertions. Implements PRD 9.2 and 9.3. Acceptance: a recorded span tree produces a
      stage breakdown; cost is computed from the versioned table and the table's version is part of
      every record; a budget assertion fails loudly rather than warning.

      Done. 31 tests, none of which sleep — the clock is injected, so every duration asserted is an
      exact number rather than "greater than zero".

      The breakdown reports self time as well as inclusive time. Summing only inclusive durations
      double-counts every parent and reports more work than the request took, which is the shape of
      number that makes a dashboard untrustworthy; a stage is answerable for its self time.

      **The price table ships empty and an unpriced model throws** (ADR 0002). Real vendor prices
      are facts this repository does not hold, and returning zero for an unknown model would make
      every cost budget in PRD 9.3 pass trivially while the error surfaced on an invoice.

      A `Measurement` cannot be constructed without a reference profile and a sample size, which is
      PRD 9.1's "a budget quoted without its profile is not quotable" made structural. Sample size
      travels with every value because a nearest-rank p95 over twenty samples is the maximum.

- [x] **P3 — `packages/governance`.** Principals, group resolution, ACL labels, audit records.
      Implements PRD 6.1 and 6.6. Acceptance: an audit record exists for every authorisation
      decision; label resolution is deterministic and tested against a permission fixture set.

      Done. 29 tests. The permission cases live in `fixtures/permissions.json` as data, so adding a
      case is not adding a test — and the same set can be replayed by the governance probe PRD 12
      item 3 requires before promotion. A test asserts the fixture contains both outcomes, so a set
      that only ever allows cannot pass unnoticed.

      **`canRead` is deliberately not re-exported from this package.** It is a fine pure predicate,
      but the only authorisation path through the governance surface is `journal.authorize`, which
      records the decision as it answers. Re-exporting the unaudited predicate would make the
      unaudited path the convenient one.

      `releaseAnswer` writes the audit before returning the answer, and withholds the answer if the
      write fails — PRD 6.6's "an audit log that can be lost on the response path is not an audit
      log", made structural. Also enforced: a failed group resolution is `ACL_UNRESOLVED` and never
      an empty group set, because empty means "reads nothing" and failure means "we do not know";
      and the abstention wording for `nothing-relevant` and `excluded-hidden` is one constant
      referenced twice, because two identical literals drift and the drift silently reopens the
      enumeration oracle PRD 6.4 describes.

- [x] **P4 — `packages/model-gateway`.** Embedding, rerank and generation interfaces with provider
      adapters, retries, and caching. Implements PRD 5 and 9. Acceptance: interfaces first, with a
      deterministic in-repo fake used by every downstream test; retry and timeout behaviour tested
      without sleeping in real time; no provider SDK reachable from any package above this one.

      Done. 24 tests, none of which wait. `Sleeper` is a port: the recording implementation resolves
      immediately and keeps the delays it was asked for, so the backoff schedule is asserted exactly
      — `[100, 200]` — rather than inferred from "it eventually succeeded", which would pass for a
      loop with no backoff at all.

      The SDK containment was demonstrated, not assumed: a real `import OpenAI from "openai"` in
      `packages/governance` produced `provider-sdk-outside-gateway` and exit 1; removing it returned
      exit 0.

      Cache first, retry inside — a cached text never enters the retry loop, and only the texts that
      miss are sent. The cache key includes the model id and dimension, because without that
      changing embedding model returns the previous model's vectors through the fastest path in the
      system rather than through a migration somebody would have reviewed.

      `MODEL_UNAVAILABLE` was added to the error taxonomy in `contracts`. Additive rather than a
      reversal, so no ADR: one code with a `kind` and a `capability` field, because PRD 9.4's
      degraded-mode switch branches on which capability is gone, not on why.

- [x] **P5 — `packages/corpus`.** Source and SourceVersion model, provenance, corpus store,
      retention. Implements PRD 4.1 and 4.2. Acceptance: a source version is immutable once
      written; change detection identifies added, modified and deleted sources; deletion is
      honoured through to retrieval eligibility.

      Done. 41 tests. The boundary was demonstrated rather than asserted: a real
      `import { fakeEmbedder } from "@atlasops/model-gateway"` in `packages/corpus` produced
      `forbidden-import` and exit 1 from `boundaries:check`, and a named `no-restricted-imports`
      failure from `lint`; removing it returned exit 0.

      **Rollback is a pointer move, literally.** A version's identity is the hash of its bytes, so a
      source reverting to earlier content produces an identifier the store already holds. Writing a
      second copy would need a different `supersedes` on an immutable record, which is a
      contradiction — so the store keeps a head pointer and a log of head movements rather than a
      linked list. That is also what makes the temporal read honest: `versionAsOf` walks the head
      log, and a date sort would return the wrong record after any rollback.

      **An access label is not a version** (ADR 0003). Identity is bytes alone, so a permission
      change produces no new version, and it must still take effect immediately rather than waiting
      for somebody to edit the document. The label has its own log, the frozen record keeps what was
      observed, and the live path re-labels. Working that through surfaced a real hazard the ADR
      records: two sources with byte-identical content share a version id and therefore share chunk
      ids, so deduplicating across ACL zones in P6 or P7 would be a leak arriving through an
      optimisation. Corpus never keys versions globally — every reference carries its source.

      **An incomplete listing cannot produce deletions.** Deletion is inferred from absence, so a
      connector returning an empty page on an expired token is one inference away from wiping a
      corpus while every layer above does exactly what it was told. Completeness is a claim the
      connector has to make, not a property of the array having entries in it.

      `SOURCE_DELETED` was added to the error taxonomy in `contracts`, and `requireInstant` to its
      public surface. Both additive, so no ADR. The first exists because a deleted source that
      upstream still lists is not a malformed input — it is a decision for a person, and the next
      crawl must not silently undo somebody's deletion.

- [x] **P6a — `packages/ingest`: parsing and chunking.** The document tree, the structure-aware
      chunker, the fixed-width fallback, and the PRD 4.4 chunk payload. Implements PRD 4.3 and 4.4.
      Acceptance: chunk boundaries are deterministic for a fixed input; a chunk never crosses a
      heading boundary above the configured depth; a table or a code block is never split mid-row;
      every chunk is a contiguous slice of its source version and carries the full 4.4 payload,
      parsed through `parseChunk` rather than merely typed; the fixed-width strategy is selectable
      per connector rather than globally.

      Done. 52 tests. The boundary was demonstrated rather than asserted: a real
      `import { rank } from "@atlasops/retrieval"` in `packages/ingest` produced `forbidden-import`
      and exit 1 from `boundaries:check`, and a named `no-restricted-imports` failure from `lint`;
      removing it returned exit 0.

      **A chunk is a contiguous slice of its source, and nothing in this package holds text.** The
      parser emits offsets; the chunker packs offsets; a draft's text is the slice. That is what
      makes PRD 4.4's character offsets and PRD 7.2's verification pass mean the same thing. A
      parser that normalised whitespace or re-emitted a heading above the block it introduced would
      produce offsets that point at nearly the cited words, and a verification pass that is nearly
      right is worse than none.

      **The Markdown parser is hand-written, for the same reason `contracts` owns its validators.**
      What this layer needs from a parser is faithful positions, and rendering-oriented libraries
      treat positions as secondary and whitespace normalisation as a feature. It recognises exactly
      PRD 4.3's five constructs and no inline syntax — inline syntax cannot change where a chunk may
      be cut, and every construct parsed is one that can be parsed wrongly.

      **The token counter is a port and the default is named `approximateTokenCounter`.** A real
      token count belongs to a specific model's tokenizer, which this repository does not hold.
      Shipping a character-ratio estimate under a name like `countTokens` would put a number that is
      not a token count into PRD 4.4's `tokenCount`, from where it reaches cost arithmetic and
      eventually a published figure, indistinguishable from a measured one. The estimate is allowed
      to decide where to cut; it is not allowed to be reported.

      Packing counts additively — the counter applied to the text between the current end and the
      new one, not to the whole candidate each time, which is quadratic in document length. The
      size a chunk finally reports is one counter call on the finished slice.

      The oversized-block splitter tries the coarsest structural cut first and only reaches a finer
      one for a segment still over budget on its own, which is how a table is cut between rows and a
      code block between lines. Under both sits a fixed-width backstop that exists solely so a
      single unbroken run terminates. A range no segmenter can divide is returned whole: an
      oversized chunk is a visible problem, a mangled one is not.

- [x] **P6b — `packages/ingest`: the pipeline.** Connectors, change detection wired to the corpus,
      embedding reuse, deletion propagation, failure isolation, and the ingestion budgets.
      Implements PRD 4.2 and 4.5. Acceptance: re-ingesting an unchanged source makes zero model
      calls; chunks whose own text hash is unchanged reuse their embedding; deletion propagation is
      complete before the job returns and a post-delete probe does not return the chunk; one bad
      source in a mixed batch fails alone; the 4.5 targets are asserted against a named fixture
      corpus, as targets with a stated measurement method rather than as results.

      **Why P6 is split.** The original entry carried six responsibilities across four PRD
      sections, and the seam between them is real rather than administrative: P6a is pure functions
      over text with no ports at all, and P6b is orchestration whose every interesting property is
      about what it does *not* call. Splitting them also splits the 4.5 table along the same line —
      re-ingestion determinism is a property of the chunker and is settled in P6a; the other four
      rows need a pipeline and a fixture corpus to mean anything. Kept as one phase, the chunker
      would have been finished under the pressure of an unstarted pipeline.

      Done. 27 tests, all five PRD 4.5 rows measured against the named fixture corpus through the
      method the PRD states. The boundary was demonstrated rather than asserted: a real
      `import { fuse } from "@atlasops/grounding"` in `packages/ingest` produced `forbidden-import`
      and exit 1 from `boundaries:check`, and a named `no-restricted-imports` failure from `lint`;
      removing it returned exit 0.

      **The index is written before the corpus records the version live.** The opposite ordering
      fails in the direction nothing recovers from: the corpus claims a live version retrieval
      cannot see, and the next crawl compares hashes, finds the source unchanged and never retries.
      This way the corpus stays put, the next run retries, and the only debris is chunks for a
      version the corpus never made live — invisible to retrieval, because eligibility is computed
      from the corpus rather than stored on the chunk. Asserted by running the whole corpus through
      a failing sink and checking the corpus is untouched.

      **A revision purges the old version from the index but never from the embedding cache.** The
      cache is keyed on chunk text, and that *is* PRD 4.2's reuse mechanism. Eviction happens on
      deletion only, where leaving a derivative behind would mean the deletion did not happen.

      Measured on `ingest-fixture-v1` with the fixture's own chunking settings: the revised document
      chunks into 28, of which 26 texts came from cache — a reuse ratio of 0.9286 against the 0.9
      floor. Two chunks were re-embedded rather than one because the edited paragraph grew past the
      token budget and split. That is a measurement of this fixture on this machine and is not a
      result for anything else.

      **PRD 4.5 gets its own budget table and its own checker.** Two of its five targets are floors,
      not ceilings, and `telemetry`'s checker compares `value <= target` because every 9.3 budget is
      a ceiling. Reusing it would have reported a corpus that reused nothing as comfortably within
      budget. What is reused is `Measurement`, which cannot be built without a `ReferenceProfile`.

      **The 9.3 ingestion cost budget is unmeasurable, not met.** `ingestionCostPer1kChunks` throws
      against the empty price table (ADR 0002), and a test asserts that it throws — the distinction
      is enforced rather than noted.

      **Named gap: this pipeline does not refresh access labels.** A connector listing carries
      identity and a content hash, so a permission change with no content change is invisible to it.
      Label refresh belongs to a pass driven by the directory, not to a content crawl. The one case
      that does surface — a source edited and reverted between `list` and `fetch` — is handled, and
      relabels in place with no re-embedding.

      `EmbeddingCache` gained a required `delete`. Additive, so no ADR, but it is required rather
      than optional because PRD 4.2's delete must reach "every cache keyed on it", and an
      implementation with no way to forget should not typecheck. The tradeoff: eviction is by cache
      key, so deleting one source also evicts an entry another live source would have hit — a cache
      miss, against refcounting a compute cache to save one re-embedding.

- [x] **P7 — `packages/indexing`.** Index adapters, schema migration, and permission predicate
      compilation. Implements PRD 6.2 — the pre-filter. Acceptance: a permission predicate is
      compiled into the index query itself; a post-filter implementation is present only as a
      rejected comparison in tests, proving the pre-filter returns no row the principal may not
      see.

      Done. 37 tests. The boundary was demonstrated rather than asserted: a real
      `import { chunksFor } from "@atlasops/ingest"` in `packages/indexing` produced
      `forbidden-import` and exit 1 from `boundaries:check`, and a named `no-restricted-imports`
      failure from `lint`; removing it returned exit 0. `ingest` and `indexing` are siblings and
      neither may import the other, which is why `IndexRow` exists beside `ingest`'s `StoredChunk`
      — an application wires the two, being the layer allowed to know about both. The comment in
      `ingest/src/sink.ts` that said otherwise was corrected.

      **The pre-filter is where the rows are, not where the filter is.** Rows live in a posting list
      per readable group, and `visible(predicate)` is the only read path out of the store — there is
      no unfiltered accessor to forget. A post-filter cannot be written against this package without
      first writing the accessor it does not have.

      **The compiled predicate is data, not a closure.** A `(row) => boolean` can be invoked
      anywhere, including after candidate generation, and nothing distinguishes a pre-filter from a
      post-filter that happens to run early. A declarative filter has to be compiled into an
      adapter's own access path, which makes that path reviewable.

      **The assertions are about the implementation, not the output.** Every search records which
      rows it touched, and the tests assert that no row the principal cannot read was examined.
      Checking returned candidates would pass equally for a post-filter.

      The rejected implementations are written out in the test file and nowhere else, so both leaks
      are demonstrated rather than described: the post-filter scores forbidden rows and returns a
      shorter result set than the pre-filter for the same limit, and a corpus-wide-IDF scorer
      re-orders the documents the principal *can* read.

      **Term statistics are computed over what the principal can read** (ADR 0004). BM25's IDF over
      the whole corpus lets documents the principal cannot read change the ordering of the ones they
      can — the same leak PRD 6.2 rejects post-filtering for, arriving through a statistic instead
      of a row. The cost: scores are not comparable between principals, which makes it load-bearing
      that fusion and the 8.2 metrics are rank-based rather than score-based.

      Also here: the existence probe PRD 6.4 needs is a separately named call returning only counts
      and policies — never an identifier, text or score — so it cannot become the post-filter under
      another name; a `hidden` source produces wording byte-identical to "nothing was found". And a
      Promise-returning method rejects rather than throwing, because a caller that wrote `.catch()`
      would otherwise crash on the synchronous branch.

- [x] **P8 — `packages/retrieval`.** Dense arm, lexical arm, RRF fusion, reranking, ablation
      switches. Implements PRD 5.1 to 5.5. Acceptance: fusion is reciprocal rank, not score
      interpolation, and a test demonstrates why on a case where interpolation misranks; each arm
      can be ablated by configuration; freshness and superseded sources are honoured.

      Done. 38 tests. The boundary was demonstrated rather than asserted: a real
      `import { inMemoryCorpusStore } from "@atlasops/corpus"` in `packages/retrieval` produced
      `forbidden-import` and exit 1 from `boundaries:check`, and a named `no-restricted-imports`
      failure from `lint`; removing it returned exit 0.

      **Retrieval may not import `corpus`**, which is the constraint that shaped PRD 5.5's
      implementation. The layer deciding what is current must not be reachable from the layer that
      ranks, so `VersionOracle` is a port and an application answers it from the corpus.

      **The interpolation comparison is a demonstration, not a quotation.** A min-max interpolator
      lives in the test file and nowhere else, with two arms in which A and B hold identical raw
      scores and identical ranks while only a third, lower-ranked document moves. Interpolation
      swaps the top two; RRF returns the same ordering. The same case asserts what RRF gives up —
      A and B tie although one dominates an arm — which PRD 5.2 accepts and points at the reranker
      to restore.

      **No line in this package drops a candidate for permission reasons**, and there is nowhere
      one could be added: the predicate is compiled once and applied by both indexes during
      candidate generation, so nothing unreadable ever arrives.

      **Every number in the config is marked unselected.** PRD 5.2 requires `k` and the depths to be
      selected on the development split and recorded in the evaluation artefact; the defaults carry
      `provenance: "unselected-default"`, every result records it, and the cache key includes it so
      a selected run can never be served from an unselected entry.

      The temporal filter runs between the arms and fusion **and renumbers**, because RRF reads
      ranks and a gap would score a live document one place worse than it is. The residual is named:
      the index's depth cutoff still counted the superseded rows, so this is a second line of
      defence behind `ingest`'s purge — which is also why an `as-of` query is only answerable over
      an index configured to retain superseded versions.

      Stemming is deliberately absent from query analysis (PRD 5.4 lists it). A stemmer must run
      identically at index time and query time; stemming only the query matches nothing, because
      `indexing` tokenises documents without it. Lowercasing and stopword removal are safe
      asymmetrically and are done.

      A `MIXED_EMBEDDING_MODEL` failure does not degrade. It is a configuration defect, and serving
      lexical-only past it would hide a broken vector index behind a slightly worse ranking for as
      long as nobody read the flag.

- [x] **P9 — `packages/grounding`.** Prompt assembly, answer schema, citation binding,
      verification, abstention. Implements PRD 7.1 to 7.3 and 6.5. Acceptance: every returned claim
      binds to a retrieved chunk; an answer that cannot be verified abstains rather than degrading;
      retrieved content is treated as data and a prompt-injection fixture does not change
      behaviour.

      Done. 40 tests. The boundary was demonstrated rather than asserted: a real
      `import { inMemoryLexicalIndex } from "@atlasops/indexing"` in `packages/grounding` produced
      `forbidden-import` and exit 1 from `boundaries:check`, and a named `no-restricted-imports`
      failure from `lint`; removing it returned exit 0. The tests build `RetrievalResult` values by
      hand for the same reason — reaching for a real index would have been the first crack in that
      boundary.

      **The injection defence is not detection.** Nothing pattern-matches the fixture passages; a
      defence built on recognising phrasings fails on the first rephrasing. Two properties hold
      whatever the passage says: a passage cannot close its own block, because the delimiter is
      neutralised on the way in — that is the injection that actually works against a naive
      assembler — and an answer produced by a model that *did* obey one cannot be released, because
      the verifier is not a language model and never reads the passage.

      **Spans are verified against the text the model was shown**, not the stored chunk. The two
      differ by a few characters exactly when a document talks about this system, and verifying
      against the chunk would reject a correct citation or accept one pointing at different words.

      **The abstention reason is for the audit; the message is for the caller.** `reason`
      distinguishes `permission-excluded` from `low-support`, which is the distinction PRD 6.4 says
      an attacker must not be able to make — so the message goes through `governance`'s constants,
      where hidden-excluded and nothing-found are the same bytes. Asserted both ways. A caller that
      surfaces `reason` to an unprivileged user reopens the oracle, which is stated in the code
      because no type can prevent it.

      One bounded regeneration, then abstention (PRD 7.2), with the failures handed to the retry.
      Bounded at one because a verifier-driven retry loop spends budget converging on an answer the
      evidence does not support, and PRD 7.3 makes abstention a feature rather than that loop's
      failure.

      Three additive changes to lower layers, none a reversal, so none takes an ADR. `Candidate`
      gained `acl`, because PRD 7.2's readability check has to be a second check rather than "it was
      in the retrieved set" twice. `FusedCandidate` gained `rerankScore`, because PRD 7.3's
      threshold is defined on the reranked score and **null is not zero** — a bypassed reranker has
      not judged the support to be poor. And `AuditRecord.costUsd` widened to `number | null`: the
      price table ships empty (ADR 0002), recording zero would fabricate a cost and throwing would
      turn a missing price list into an outage.

- [x] **P10a — `packages/evalkit`: datasets and the computable metrics.** The four dataset shapes
      as content-hashed, versioned artefacts with a protected held-out split, and every metric that
      can be computed without a judge. Implements PRD 8.1, 8.2 (rows 1, 3, 5, 6) and 8.4.
      Acceptance: a dataset's hash is derived from its items and a declared hash that disagrees is
      rejected; the held-out split cannot be read by the development path without an explicit,
      recorded unseal; recall@k, nDCG@10 (graded, not binary), MRR and per-retriever contribution
      are computed from graded labels; citation precision, citation recall and span-validity are
      computed against the supporting-chunk set; correct-abstention and over-abstention are
      computed against the abstention set; leak count and existence-disclosure count are computed
      against the permission probe set, and leak count is a hard binary gate at zero; per-query
      scores are retained rather than only aggregates.

      Done. 40 tests. The boundary was demonstrated rather than asserted: a real
      `import { inMemoryChunkSink } from "@atlasops/ingest"` in `packages/evalkit` produced
      `forbidden-import` and exit 1 from `boundaries:check`, and a named `no-restricted-imports`
      failure from `lint`; removing it returned exit 0.

      **A `MetricResult` cannot be built without the per-query scores it came from.** PRD 8.5's
      paired bootstrap is the whole regression gate, and a metric implemented as "return the mean"
      would have thrown away the only thing it can be paired on. `metricResult` is the single
      constructor and derives the aggregate; the aggregation is named, because leak count is a sum
      and one leak in two hundred queries is not 0.005 of one.

      **The leak gate throws rather than returning a number**, and there is deliberately no
      configurable threshold — there is no argument for the acceptable number of leaks, and a
      configurable one is a number somebody raises at 5pm on a Friday. The count includes anything
      that reached the candidate set, not only what was cited: PRD 6.2 forbids materialising an
      unreadable chunk into the prompt at all, and the prose is downstream of it either way.

      **nDCG is graded and its ideal ranking comes from every label.** A test holds two runs that
      recall scores identically and graded nDCG does not, with the expected value worked out in the
      test rather than taken from the implementation. An IDCG over the retrieved set would score a
      run that missed the best passage entirely as perfect.

      Datasets recompute their own content hash and refuse a file whose labels moved without its
      version moving — the first of PRD 8.1's two ways to fake an improvement. The hash is over a
      canonical rendering, so reformatting a fixture does not force a version bump. The held-out
      split is sealed: the development path gets development items and `unseal` needs a stated
      reason that the handle carries into whatever artefact is built from it. Not impossible to
      read, which it cannot be — impossible to read by accident or in silence.

      Two smaller decisions worth naming. An abstention is excluded from citation precision rather
      than scored 1, because a system that never answers would otherwise be perfectly precise, and
      it is scored 0 on recall, because the material existed and the answer did not reach it.
      Existence disclosure is compared against `governance`'s own wording constants rather than a
      copy of them, since two identical literals drift and the drift makes the count fall to zero
      for the wrong reason.

- [x] **P10b — `packages/evalkit`: the harness, statistics and reporting.** The ablation runner,
      judged metrics with PRD 8.3's three controls, the paired bootstrap, and the report artefact.
      Implements PRD 8.2 (rows 2, 4, 7), 8.3 and 8.5. Acceptance: the harness runs an answer system
      across a dataset version and emits the full 8.2 table plus per-query raw results; four
      ablation arms run over the same dataset version and report deltas; a judged metric carries
      its judge's model identifier, prompt version and judge-human agreement, and a judged
      improvement paired with a retrieval regression is reported as a regression; regression
      detection is a paired bootstrap on per-query deltas with the gate on the confidence
      interval's lower bound, not the point estimate.

      **Why P10 is split.** The original entry carried five responsibilities across five PRD
      subsections, and the seam is the same one that made P6's split work: P10a is pure functions
      over labelled data and recorded outputs, with no ports at all, while P10b is orchestration,
      a judge dependency, and statistics whose whole point is that they are not a single threshold.
      They also fail differently — a wrong metric is a silently wrong number, and a wrong gate is a
      release that should not have shipped — so grading them in one pass means grading neither
      carefully.

      Done. 45 tests. The boundary was demonstrated rather than asserted: a real
      `import { inMemoryVectorIndex } from "@atlasops/indexing"` in `packages/evalkit` produced
      `forbidden-import` and exit 1; removing it returned exit 0.

      **The bootstrap earns its place in one pair of tests.** Two runs with an identical mean delta
      of 0.005 get opposite verdicts: a handful of queries moving both ways is `no-change`, and a
      uniform shift across all two hundred is `improvement`. A third test asserts the direction that
      flatters the method less — four queries out of two hundred each gaining a full point, with
      nothing worse, _is_ called an improvement, because it is one. The machinery is for telling
      noise from signal, not for refusing small samples on principle.

      **The gate reads the interval's lower bound**, with a test where the point estimate is
      positive and the gate still refuses. The tolerance ships unselected at zero, which is
      conservative on purpose — the remedy for a wide interval is more queries, not a looser gate.

      **Judged metrics cannot be obtained without the agreement that qualifies them.**
      `judgedMetrics` returns the supported-claim rate, the contradiction rate and judge-human
      agreement as one value, and throws when no calibration item carries a human label. The judge
      is pinned by model and prompt version, and `requireSameJudge` refuses a comparison across a
      change to either. PRD 8.3's third control lives in the comparison: a judged improvement beside
      a retrieval regression comes out as a regression, before anything else can call it a win.

      Two corrections I made to my own test expectations rather than to the code. A three-query
      fixture cannot support a confident verdict, so the end-to-end regression test now asserts
      `no-change` _and_ a failed gate, with the reason naming the sample size — and the
      verdict-logic tests feed per-query scores directly instead of enlarging the fixture until the
      numbers came out. The `lowerIsBetter` set is what stops a rise in leak count reading as an
      improvement; there is a test for the sign flip.

      Deliberately conservative elsewhere: `compareRuns` refuses two different arms, two different
      dataset versions and two different judges; `compareArms` is a separate operation, because an
      ablation is not a regression and running one through the release gate would report
      "dense-only is worse" as a build failure. The report prints dataset versions, sample sizes,
      the reason any row is empty, whether the run read the held-out split, and — when a p95 rests
      on twenty samples or fewer — that it is a maximum wearing a percentile's name.

      The grounded-answer fixture moved to 1.1.0 when the calibration labels were added: the labels
      changed, so the hash moved, so the version had to. That is P10a's mechanism working on its
      first real edit rather than a nuisance.

- [x] **P11a — `packages/composition`: the composition root.** The answer pipeline and the
      ingestion pipeline, assembled from ports, so that the thing the evaluation measures and the
      thing the API serves are the same object. Implements PRD 10's separation of concerns and
      11.2's rule that a shared helper is promoted into a package rather than imported sideways.
      Acceptance: a new layer between `evalkit` and the application group, declared in
      `layers.json` with an ADR; the answer pipeline is constructed once and consumed by both the
      API and the evaluation runner; a stalled ingestion job does not degrade answer latency, and
      a test demonstrates that by interleaving a hanging ingestion with answered queries.

      Done. 15 tests, and the first in the repository that run the whole system end to end —
      ingest a corpus, index it, answer from it, with only the provider boundary faked. The new
      layer was demonstrated in both directions: `composition` importing `evalkit` is clean, and
      `evalkit` importing `composition` produced both `forbidden-import` and, independently, a
      `dependency-cycle` from the checker that had no way to know the first rule existed.

      **`asAnswerSystem` is a rename, not an adapter**, and that is the whole point of ADR 0005. If
      it had to reshape anything, the evaluated object and the served object would be different
      objects again — which is the failure that makes PRD 8 worthless, because an evaluation would
      pass while the API served something subtly different.

      **The stalled-ingestion test says exactly what it shows and no more.** Answers complete, and
      complete identically, while a crawl that will never return is in flight; and a second test
      asserts structurally that the answer pipeline exposes no handle through which it could wait
      on one. It is **not** a latency measurement — nothing here has measured latency, and PRD
      section 0 does not permit one to be claimed from a run like this. The first version of the
      test passed for the wrong reason: with the handbook removed there was nothing left to fetch,
      so the hang never triggered and the crawl completed. It now adds a source the crawl must
      fetch.

      Two joins live here because this is the only layer allowed to see both sides.
      `indexingChunkSink` adapts `ingest`'s sink onto `indexing`'s indexes, keeping its own record
      as well — `indexing` deliberately has no unfiltered accessor (P7), and that decision is worth
      more than the convenience of reading a row back. `corpusVersionOracle` answers `retrieval`'s
      "is this current" from the corpus on every call rather than from a cached snapshot, because a
      cached view is a window during which retrieval cites a superseded revision as current.

      The cost, stated in the ADR: one more layer, and a package permitted to import everything
      below it is an inviting home for anything two applications happen to share. The mitigation is
      that it holds assembly and no utilities, opens no connection, and reads no configuration.

- [x] **P11b — The four applications.** `apps/api`, `apps/ingest-worker`, `apps/eval-runner`,
      `apps/console`. Implements PRD 10. Acceptance: the four run from documented commands;
      each is wiring and configuration over `packages/composition` and nothing else; no
      application imports another, and that is demonstrated rather than asserted; the console is
      read-only over answers, traces and evaluation artefacts.

      **Why P11 is split.** `apps/eval-runner` has to evaluate the same answer pipeline
      `apps/api` serves, and an application may not import another application — so without a
      promoted composition package the runner would rebuild the pipeline itself, and an
      evaluation could then pass while the API served something subtly different. That is not a
      tidiness problem; it is the failure that makes the whole of PRD 8 worthless. PRD 11.2
      already prescribes the fix ("promote it into a package with a defined contract — a
      deliberate, reviewed act"), and doing that is a boundary change with its own ADR, which is
      exactly the kind of thing that should not be buried in a commit that also adds four
      applications.

      Done. 47 tests across the four, and all four commands were run end to end rather than
      assumed: `app:ingest` crawled `examples/corpus` and wrote 6 chunks; `app:eval` ran all four
      arms and wrote five artefacts; `app:api` served a real cited answer over HTTP; `app:console`
      served the artefact index, set a content-security-policy and refused a traversal with 404.
      The boundary was demonstrated — `apps/eval-runner` importing `apps/api` produced
      `app-is-a-leaf` and exit 1; removing it returned exit 0.

      **What is not installed is stated where somebody will read it.** No provider adapter exists,
      so every model identifier these processes record says so — `stand-in-embedder`,
      `stand-in-reranker`, `stand-in-not-a-model` — and `apps/README.md` leads with the two
      consequences: the embedder has no semantic structure, so the dense arm returns candidates for
      a query the corpus cannot answer and the API answers almost anything with something; and the
      generator does no language modelling. There is a test asserting that first one rather than
      leaving it as a footnote. No persistent store exists either, so the four processes cannot
      share a corpus, which is why the API and the runner crawl one themselves — and both refuse
      any other profile by name rather than falling back.

      **The evaluation runner refuses a dataset labelled against a different corpus**, which is PRD
      8.1's second way to fake an improvement. The in-repo fixtures are labelled against no corpus,
      so `app:eval` passes `--allow-snapshot-mismatch` and every artefact it writes says on its
      face that the numbers are not comparable to a run whose snapshot matched.

      Smaller decisions worth recording. The worker exits non-zero when a source failed: isolation
      is about not losing the good sources, not about making the bad one invisible to a scheduler.
      The API never returns `Abstention.reason`, and the test asserts the whole key set rather than
      the absence of one name. The console refuses anything that is not a GET before it looks at a
      path, and allow-lists artefact names against the directory listing rather than blocking `..`.

      `filesystemConnector` was added to `ingest` — connectors are its row in PRD 11.2, and two
      applications need one. It makes PRD 4.2's `complete` flag real: an unreadable subdirectory
      produces a partial listing rather than a short one, so the corpus withholds deletions instead
      of acting on a crawl that half-failed. `citingStandIn` was added to `grounding`, which owns
      the answer schema it emits.

      One process note: I corrupted all four entry points with a PowerShell `Get-Content -Raw` /
      `Set-Content` rewrite — BOM added, em dashes mojibaked — and rewrote them properly. That is
      the third time that pair has damaged UTF-8 in this project; source edits go through the
      editing tools.

- [x] **P12 — Evidence.** Produce the artefacts PRD 12 requires: the evaluation report, the
      governance report with a zero leak count, the cost and latency report against the 9.1
      reference profile, and the boundary-enforcement artefact showing at least two exhibits
      consuming `packages/*` and importing no other exhibit. Acceptance: every artefact exists and
      is reproducible from a command. Only then may the portfolio manifest be proposed for
      promotion — as a separate reviewed edit, never implied from here.

      Done, and the honest answer is **not every artefact exists**. Five of PRD 12's seven are
      produced; two cannot be, and the phase's real deliverable is
      `docs/promotion-readiness.md`, which says so item by item and concludes that the manifest
      stays at `proofLevel: "code"`.

      **Met:** a running system (item 1, four documented commands run end to end in P11b); the
      governance report (item 3); the threat model (item 6); the limitations list (item 7). The
      evaluation report (item 2) is produced and records everything PRD 12 asks for — dataset
      versions and hashes, corpus snapshot, commit, model identifiers by role, the judge's pinned
      prompt version, run count, per-query records, the full 8.2 table with a stated reason for
      every row that could not be computed — and **supports no claim about quality**, because every
      model in it is a stand-in.

      **Not met:** item 4, the cost and latency report, blocked twice over — no load run exists,
      and the price table ships empty (ADR 0002) so cost is unmeasurable rather than zero. Item 5,
      the boundary artefact, requires the graph to show at least two exhibits consuming
      `packages/*`; there are **no exhibits**, and `pnpm boundaries:evidence` writes that into the
      file it generates rather than rendering the half it can.

      **The governance report is the one artefact stated without qualification**, because a leak
      count measures the permission pre-filter — ordinary code with no model in it. Zero leaks over
      three probes, zero within the injection subset, zero existence disclosures, and the
      audit-record schema derived from a record the run actually wrote rather than transcribed.

      **Generating the artefact found a real bug in my own metric.** The first run reported two
      existence disclosures. `existenceDisclosureCount` was counting any message other than the
      nothing-found wording, which made every successful answer a disclosure — but PRD 8.1 item 4
      says a correct system returns "nothing or a restricted answer", and an answer built from
      material the principal *can* read says nothing about what was withheld. Fixed to compare
      against the `excluded-visible` wording, with a test for the case that was miscounted. That is
      what generating evidence is for: the number was wrong in the flattering-to-notice direction,
      and only running it surfaced that.

      Two datasets moved version again, for the reason the mechanism exists: the probe set gained
      the injection marker PRD 12 item 3 needs, so its labels changed, so its hash moved.

## Phases added after P12

P0–P12 built the system and then refused to promote it, because `docs/promotion-readiness.md`
found two of PRD 12's seven artefacts unproducible: item 4 needs a load run and a priced table,
and item 5 needs two exhibits that do not exist. Those are not defects in the phases already
done — they are work nobody had scheduled. The phases below schedule it.

They are in dependency order for the same reason the first thirteen were. A load run against
stand-in models measures the stand-ins; labelled datasets that do not match the corpus they are
scored against cannot support a quality claim whatever models produced them; and an exhibit
written before there is a real adapter would be a second consumer of the fake.

**The provider decision is made and is OpenAI for embeddings and generation** — one SDK, one key,
one published price list. PRD 14 left the embedding model, the reranker and the judge family
deliberately open, "to be settled by measurement or by ADR rather than by assertion", so P13
settles the first by ADR and leaves the reranker open, because OpenAI has no first-party rerank
model and inventing one is not available.

- [x] **P13 — `packages/model-gateway`: a real provider adapter and a priced table.** An OpenAI
      embedding adapter and generation adapter behind the existing ports, plus the versioned price
      table populated for exactly the models used. Implements PRD 5, 9.2 and ADR 0002's unfinished
      half. Acceptance: the adapters satisfy the existing `Embedder` and `Generator` interfaces with
      no change to either, so nothing above the gateway can tell a real model from a stand-in except
      by the model identifier it records; **no test reaches the network** — the transport is a port
      and tests drive recorded responses; a separate opt-in command performs one live call and is
      never run by CI; the API key is read from the environment, never a file, and is absent from
      every error message and span; **every price in the table carries its source URL and the date
      it was read**, and an unpriced model still throws rather than costing zero; retry, timeout and
      `MODEL_UNAVAILABLE` behaviour hold against the real adapter, tested through the transport port
      without sleeping; an ADR records the dependency, the model identifiers chosen, and the fact
      that the reranker remains unselected rather than quietly dropped.

      **The rule this phase must not break.** A provider SDK is confined to the gateway by a
      boundary rule keyed on package names. An adapter written with bare `fetch` would evade that
      rule entirely, because any package can call a URL. Whichever way the adapter is built, the
      phase adds an enforcement that matches — by package name, by endpoint, or both — and
      demonstrates it failing before it passes.

      Done. 35 new tests (589 total across 22 files). **Not one line above `model-gateway`
      changed**, which is the result this phase was really testing: the ports written in P4 held, so
      a real model arrives as a constructor swap and every existing test still runs offline.

      **No SDK** (ADR 0006). The adapter speaks the two REST endpoints it needs over an
      `HttpTransport` port: no dependency to audit or pin, and a wire shape a test can record
      exactly. The cost is written into the ADR rather than discovered later — request shaping and
      error mapping are hand-written, and **streaming is not implemented**, which is work P15 needs
      for PRD 9.3's time-to-first-token and which an SDK would have given away.

      **The endpoint rule is the part that mattered.** `provider-sdk-outside-gateway` matches import
      specifiers, and `fetch("https://api.openai.com/…")` is not an import — so an SDK-free adapter
      would have left the gateway boundary enforced against a shape nothing in this repository uses,
      passing CI while any package talked to the provider directly. `providerEndpoints` is now a
      required block in `layers.json` (an absent one would read exactly like a passing rule), and
      the rule was demonstrated in both directions: a real `fetch` to the host in
      `packages/governance` produced `provider-endpoint-outside-gateway` and exit 1; deleting it
      returned exit 0. It matches the host in a comment too, which is deliberate — the alternative
      is deciding which occurrences are load-bearing, and that judgement is what lets the real one
      through.

      **Prices are facts, so they carry a citation.** `ModelPrice` now requires `source` and
      `retrievedOn`, which means even a test's synthetic price has to say it is synthetic. The
      figures were read from the vendor's published list on 2026-09-24 and the table version is that
      date rather than a sequence number, so a cost record stamped with it can be re-derived. The
      default table stays empty: a stand-in that costs nothing to call must not acquire a price by
      inheritance.

      **Two guards against the standing bar being broken by accident.** `fetchTransport` throws if
      it is called under the test runner, so an adapter constructed without a transport fails loudly
      instead of quietly spending money; and the recorded transport refuses to invent a reply it was
      not given, so a test cannot assert two calls when one happened.

      The adapter's failure tests are the ones worth reading: a provider can hand back something
      entirely plausible and wrong. Vectors are ordered by the response's `index` field rather than
      by array position, because a mispaired embedding is invisible — it retrieves confidently wrong
      passages instead of failing. A short batch, a wrong-width vector, a truncated answer and a
      response with no token usage each stop the call rather than degrading it; missing usage in
      particular cannot default to zero, because zero is a real number that prices to nothing.

      **What this phase did not do, and the documents now say so.** No application constructs the
      adapter, no evaluation run has used it, and no artefact here was produced with it, so
      `docs/limitations.md` and `docs/promotion-readiness.md` were corrected to state that an
      adapter exists and nothing has run against it — the opposite error (a repository claiming real
      models because a file exists) is exactly what PRD section 0 is for. **`pnpm smoke:openai` has
      never been run**: it needs a key this machine does not have, and it is the only thing that can
      prove the recorded wire shape is still the live one.

      Still unselected: the reranker. OpenAI publishes no first-party rerank model, so PRD 5.3's
      cross-encoder has no adapter and the reranker stays bypassable, named as unselected rather
      than filled in with an invented identifier.

- [x] **P14a — The corpus, its access zones, and a pinned inventory.** The fixed corpus the labels
      will point at: documents across several ACL zones including a `hidden` source and the PRD 6.5
      injection passages, a connector that can express per-source labels, and a committed inventory
      of every chunk identifier the corpus produces. Implements PRD 9.1's "fixed corpus snapshot"
      half and the corpus half of 8.1. Acceptance: `filesystemConnector` resolves an ACL per path
      and **fails closed** on a path the manifest does not cover, because a default label is how
      "unknown" becomes "public" (PRD 6.1); the corpus contains material at least one principal must
      not read, or the permission probes in P14b would be vacuous; the snapshot hash is computed by
      one function that both the evaluation runner and the inventory tool call, asserted equal — two
      implementations that drift make every dataset pin wrong; the inventory is generated rather
      than hand-maintained, and a stale one fails `pnpm verify`; the construction procedure is
      written down as PRD 13 requires.

      Done. 30 new tests (619 total across 24 files). The corpus is eight documents in four zones —
      `public/`, `engineering/`, `finance/` and a hidden `restricted/` — producing 35 chunks, pinned
      at `sha256:f05a2049…`.

      **The connector could not express a zone, and that was a real gap rather than a missing
      convenience.** One label for a whole root describes only a corpus everybody may read, so every
      permission metric over it is zero because nothing is forbidden — a leak count that is
      arithmetic rather than evidence. `aclFor` resolves a label per path from a manifest that sits
      **outside** the crawl root, because a label file inside it would be ingested, chunked and
      retrievable: an access-control policy answering questions about itself.

      **There is no default label and there is not going to be one.** A path no rule covers fails
      its own fetch with `ACL_UNRESOLVED`, which was demonstrated rather than asserted: an
      unlabelled file added to the corpus produced exactly that, the other eight sources ingested
      anyway (35 chunks written, PRD 4.5 isolation intact), and `app:ingest` exited 1. The rejected
      alternative is the one that looks harmless — a permissive default — and it is how a document
      nobody labelled becomes a document everybody can read.

      **The snapshot hash was a private function inside `apps/eval-runner`.** Promoted to
      `@atlasops/composition` alongside `CORPUS_CHUNKING`, because the inventory tool needed both
      and an application may not import an application. Two implementations would have agreed until
      they did not, and the failure would have been a dataset pin nobody could explain. The live
      proof is that `pnpm app:eval` and `pnpm corpus:inventory` print the same hash. Chunking is
      shared for the same reason and a sharper one: chunk identifiers derive from a version and an
      ordinal, so a tool inventorying at a different token budget would mint identifiers the runner
      never creates — labels pointing at nothing while the snapshot matched perfectly.

      **The inventory is generated and checked, and `pnpm verify` runs the check.** Demonstrated in
      both directions: appending one sentence to a corpus document made `pnpm corpus:check` fail and
      say why; reverting returned exit 0. Without it, editing a document would move every identifier
      pointing into it, the labels would reference chunks that no longer exist, every metric would
      still compute, and the numbers would quietly describe a smaller corpus. That is the failure
      class this repository cares about most: the one that leaves the build green.

      **The zones were built to be tempting, not tidy.** The finance documents deliberately reuse
      the support handbook's vocabulary — "refund", "window", "exception" — so a question an
      engineering principal may legitimately ask has forbidden material sitting right beside the
      answer. A corpus whose zones share no vocabulary lets lexical mismatch do the pre-filter's
      job and makes the enforcement look better than it is; there is a test asserting the overlap
      survives. Checked live over HTTP: `prn_reader` asking about the quarter close cited a public
      document, `prn_frank` asking the same cited the finance one, and the hidden `restricted/`
      source surfaced for nobody.

      `docs/corpus-procedure.md` is PRD 13's published construction procedure, including the part
      nobody enjoys writing: I wrote all eight documents myself, in one pass, no domain expert has
      read them, and every policy number in them is plausible and invented.

- [x] **P14b — The four labelled datasets.** Graded relevance labels, grounded answers with their
      supporting chunks and a human calibration subset, the abstention set, and the permission
      probes — all labelled against P14a's snapshot. Implements PRD 8.1. Acceptance: `app:eval` runs
      **without** `--allow-snapshot-mismatch` and the flag comes out of the script; the held-out
      split is sealed and selection uses the development split; the adversarial subpopulations are
      the hard cases rather than the convenient ones; a graded label set is not a binary one
      relabelled; the procedure records who labelled each item and on what basis.

      **Why P14 is split.** The seam is the one that made P6, P10 and P11 work: P14a is the thing
      labels point at, P14b is the labels, and P14a's output — a chunk inventory — is literally
      P14b's input. They also fail differently. A wrong corpus is a wrong denominator that makes
      every metric mean something else; a wrong label is a quiet bias toward the system that
      produced it. Grading both in one pass means grading neither carefully, and the label work is
      where the temptation to flatter lives.

      **Why this is a phase at all and not a fixture edit.** Every quality number the build can
      produce is currently scored against datasets labelled for no corpus, which is why every
      artefact says on its face that its numbers are not comparable. Fixing that is the difference
      between an evaluation report that records a run and one that supports a claim. The labels are
      my judgments and the procedure has to say so — an honest small dataset with a stated method
      beats a larger one whose provenance is a shrug.

      Done. 35 labelled items — 14 graded relevance, 7 grounded answers, 7 abstention cases, 7
      permission probes — pinned to `sha256:f05a2049…`, and `app:eval` runs with
      `--allow-snapshot-mismatch` gone from the script for the first time. 623 tests across 24
      files.

      **The held-out split was not held out.** The seal in `dataset.ts` governed who could *obtain*
      held-out items and said nothing about what happened once a runner held a whole dataset — so
      the routine command read the held-out split on every run, and the protection was a comment.
      The harness now evaluates development only unless a caller passes both splits **and a
      reason**, which travels into the artefact; `pnpm app:eval -- --final "<reason>"` is the way
      in. This was not in the phase's plan; it was found by reading what the first labelled run had
      actually executed.

      **The injection probe was in the held-out split**, which the previous point turned from
      harmless into a real gap: the gate that runs on every build would never have exercised
      injection at all, while PRD 8.4 gates every run on leaks rather than only the final one. Moved
      to development, with a plain probe taking its place so the seal still has something to refuse.
      Labels changed, so the hash moved, so the fixture went to 1.2.0 — the mechanism working again.

      **The governance report was counting probes that never ran.** With held-out excluded, the
      metric threw rather than scoring them, which is the right failure — but the report now
      separates "probes declared" from "probes in scope for this run", because the alternative
      reading is that a held-out probe nobody executed was clean.

      **`pnpm datasets:check` checks what `loadDataset` structurally cannot.** `loadDataset`
      recomputes a content hash and closes PRD 8.1's re-labelling route; it has never seen a corpus.
      The new check catches four mistakes that are all silent downstream: a stale snapshot pin, a
      label pointing at a chunk that no longer exists, a probe forbidding a chunk the principal may
      read, and — the mirror, and the worse one — a relevance label on material the principal may
      *not* read, which asks the system to leak and scores obedience to PRD 6.2 as a miss.
      Demonstrated live: repointing one relevance label at a finance chunk produced exactly that
      complaint and exit 1.

      **The first labelled run found something, which is what evaluation is for.**
      `correct-abstention` came out **0 over 4** — the system answered every question it should have
      refused. That is truthful about what is wired today and unsurprising once stated: with a
      stand-in embedder every passage looks equally relevant, so PRD 7.3's support threshold never
      decides anything. It is recorded in `docs/limitations.md` and `docs/corpus-procedure.md`
      rather than left in an artefact nobody re-reads, because a zero in a row named
      "correct-abstention" reads as a pass at a glance.

      The labelling procedure is published with the part that weakens it: I wrote the corpus and
      then labelled it myself, the same afternoon, with no second reader, knowing what the system
      does. No method fixes that, and the retrieval numbers carry it.

- [x] **P15a — Instrument the stages the budgets name.** A span per stage across the whole request,
      not only the retrieval half. Implements PRD 9.2's "every request carries a trace with a span
      per stage". Acceptance: `permission-resolution`, `permission-compile`, `prompt-assembly`,
      `generation`, `verification` and `audit-write` all produce spans on an ordinary answer; the
      audit record carries the **request's** breakdown rather than a copy of the retrieval trace's;
      a model-calling span records its model identifier, tokens, cost and retry count as PRD 9.2
      requires; the trace is assembled in one place rather than three, and a stage missing from a
      trace is visible rather than silently absent from an aggregate.

      **Why P15 is split.** The load harness was built first and immediately reported four of PRD
      9.3's six latency budgets as "not measured": nothing anywhere opens a span for permission
      resolution, prompt assembly, generation, verification or the audit write. It also showed that
      `groundAnswer` seals the audit with `stageBreakdown(retrieval.trace)` — the audit has been
      recording the retrieval stages under the name of the whole request's timings since P9. A
      report cannot be honest about stages nothing measures, so the instrumentation is its own
      phase and the report follows it.

      Done. 642 tests across 25 files. Four of PRD 9.3's six latency budgets are now measurable
      where two were: `PERMISSION-P95` and `VERIFICATION-P95` went from "not measured" to figures
      over 260 requests. The two that remain unmeasured are unmeasurable rather than uninstrumented
      — time to first token needs streaming the adapter does not do (ADR 0006), and every cost row
      needs a priced model (ADR 0002).

      **The audit had been recording the wrong thing since P9.** `groundAnswer` sealed every record
      with `stageBreakdown(retrieval.trace)`, so the field named `stageTimings` carried the
      retrieval stages and nothing identified it as a subset. It now carries the merged breakdown of
      the whole request. Anything that read an audit for a stage breakdown before this was reading
      half a request and could not tell.

      **Three traces, one breakdown.** Permission resolution happens in the composition root before
      retrieval begins, retrieval traces its own arms, and grounding now traces assembly,
      generation, verification and the audit write. `mergeStageTimings` sums them per stage in PRD
      9.2's declared order — summing rather than concatenating, because a consumer handed the same
      stage twice adds it twice, which is precisely what the first load run did when it combined the
      retrieval breakdown with the audit's copy of it and reported every retrieval stage at double
      its time.

      **`trace.snapshot()` exists for exactly one caller.** The audit write is a stage whose work is
      writing the record that carries the breakdown, so it cannot report its own duration inside
      that record. The snapshot returns the spans closed so far without closing the trace; the
      record therefore has `audit-write` absent rather than present and wrong, and
      `GroundingResult.timings` — finished after the write — has it. There is a test for each half.

      **`ModelCall.cost` widened to `CostRecord | null`**, the same widening `AuditRecord.costUsd`
      took in P9 and for the same reason. `toModelCall` threw for an unpriced model, so a generation
      span could not be recorded for a stand-in at all — the choice was a fabricated zero, which
      makes every cost budget pass trivially, or an uninstrumented stage, which is what it was. Null
      keeps the span and refuses the number. `traceCost` gained a companion, `unpricedCalls`,
      because a cost total over a trace where half the calls had no price is a real number
      describing half the work and nothing in the figure says so.

      **Permission compilation got its own span.** It was inside `query-normalisation`, so PRD 9.3's
      "permission resolution + compile" budget could never have aggregated it: it was counted under
      a stage the budget does not name and missing from the one it does.

      One thing deliberately not done: the resolution span is not ended in a `finally`. A failed
      permission resolution produced no measurable stage, and recording a duration for work that did
      not complete would put it into a percentile.

- [x] **P15b — The reference profile, the load run, and the cost and latency report.** The PRD 9.1
      profile as a committed record, a scripted load run at a stated concurrency, and PRD 12 item 4.
      Implements PRD 9.1, 9.2's aggregate views, and 9.3. Acceptance: the profile records the corpus
      snapshot hash, the query workload, pinned model identifiers, the hardware, and the
      concurrency, and every reported number carries it; the report contains the full stage
      breakdown, the ratio of ingestion to serving cost, cache hit rate per cache, and tail latency
      by stage; cost comes from per-request token accounting against the versioned price table, not
      from a dashboard; p95 figures resting on twenty samples or fewer are labelled as the maxima
      they are; a budget that is missed is reported with its stage breakdown and **is not raised**;
      **and the report distinguishes the requests that were served from the retrieval cache from
      the ones that were not** — the first run of the harness put 247 of 260 requests through the
      cache, so its end-to-end p95 was a measurement of a cache hit wearing the name of an answer.

      Done. 662 tests across 26 files. `pnpm loadrun` runs the workload at a stated concurrency and
      writes two things: `docs/measurements/load-run.json`, which is committed and is what CI reads,
      and `evidence/cost-and-latency.md`, which is rendered from it. Five of the ten budgets are
      measured; the other five say why they are not.

      **The cache split is the finding this phase was reorganised around.** Over 260 requests, 247
      were served from the retrieval cache. Combined end-to-end p95 is 2.6 ms, the cache-hit
      population 2.0 ms, and the cache-miss population **53.3 ms** — twenty-five times the figure
      the combined row reports, and the only one of the three that describes answering a question.
      All three are in the table, and the end-to-end budget row carries a machine-readable `caveat`
      field saying which population dominates it, so the warning survives being copied out of the
      prose into something that quotes the number.

      **Five budgets report themselves unmeasured, and each says why.** Time to first token needs
      streaming the adapter does not do (ADR 0006); the four cost rows need a priced model and every
      model here is a stand-in (ADR 0002). Zero would have made all four pass trivially. A stage
      with no spans is reported the same way rather than as zero, which has a test.

      **CI enforces the budgets against the committed record**, because a load run cannot go in CI —
      against real models it costs money on every push, against stand-ins it measures the runner.
      `pnpm loadrun:check` fails the build on a breach, demonstrated by editing the record's
      end-to-end figure to 4,200 ms and watching it exit 1 with the "the target is not raised"
      wording from PRD 9.3. The gap this leaves is stated rather than papered over: a regression
      surfaces at the next deliberate run rather than the next push, and the check prints the
      record's age so its currency is visible.

      **`runPool` is exported so the concurrency claim can be tested.** `Promise.all` over the
      schedule would put the whole workload in flight at once — a spike of N rather than a sustained
      level of C, whose p95 is a queueing artefact. A test asserts the pool never exceeds its size.

      **Item 4 of PRD 12 is still not met, and the reason moved.** It was blocked by the absence of
      a harness; it is now blocked only by the absence of a real model, which is a configured key
      away rather than a phase away. `docs/promotion-readiness.md` says which of the two it is, and
      deliberately does not list the five measured figures — "within target" on this run means
      "within target when no model is called".

      **CI cannot run this and the phase must say so.** PRD 9.3 wants budgets enforced in CI against
      the reference profile, but a load run calls a paid API and CI must not. The split this phase
      makes: the run is a deliberate command whose artefact is committed, and CI enforces the
      budgets **against that artefact** — so a regression is caught at the next run rather than at
      the next push, and the artefact's own date says how stale the enforcement is. That is weaker
      than the PRD's wording and the gap is recorded rather than papered over.

- [x] **P16 — `exhibits/rag-02-codebase`.** The first exhibit: the Codebase Intelligence Assistant
      named in `content/projects/RAG-02.json` — index symbols, call graphs and history; answer with
      line-level citations; respect repository boundaries. Implements PRD 11.2's leaf rule for real.
      Acceptance: it consumes `packages/*` and imports no application and no other exhibit, and that
      is demonstrated by a real import failing the checker rather than asserted; it adds no new edge
      to the layer graph — anything it needs that does not exist is promoted into a package
      deliberately, with an ADR, or the exhibit does without it; it has its own README, fixtures and
      dataset; its citations resolve to line ranges in a source version, not to file names.

      **This is the first test of the reuse claim.** The whole argument for the layered structure is
      that fourteen exhibits can share one ingestion and evaluation stack. Until an exhibit is built
      on it, that is a design intention. PRD 13 names the failure mode exactly: if the graph check
      produces more friction than protection here, that is a finding for an ADR, not a rule to
      quietly stop running.

      Done. 22 tests in the exhibit, 687 in total across 27 files. **No package changed.** The one
      thing a codebase needed that prose did not — a chunker that knows where a declaration starts
      — plugged into `ingest` through the `ChunkStrategy` interface that already existed, and the
      rest came from `packages/*` as they were: ingestion, the access manifest and pre-filter,
      hybrid retrieval, grounding, verification, the audit, and `evalkit`'s own recall and MRR.
      PRD 13 predicted that the graph check might produce more friction than protection once a real
      exhibit arrived. It produced none — and it caught something, below.

      **The leaf rule had a hole, and only a real exhibit could have found it.** `exhibit-is-a-leaf`
      had been demonstrated since P0 against an import written as a relative path. The normal way
      to import a workspace package is by its name, and `@atlasops/exhibit-rag-02-codebase`
      resolved to EXTERNAL, so a package importing the exhibit by name passed the checker as though
      it were an npm dependency. Demonstrated: with both a relative exhibit-to-app import and a
      named package-to-exhibit import in place, the checker reported one violation, not two. It now
      reads every application's and exhibit's package name; the same two imports produce
      `app-is-a-leaf`, `exhibit-is-a-leaf` and the dependency cycle between them, and removing them
      returns exit 0. P12 had written that the rule "would fail CI today" — true only for the form
      nobody writes — and `docs/promotion-readiness.md` now says so.

      **Citations are line ranges in a version**, `platform/retry.ts:17-18 @ sv_…`, computed from
      the exact bytes of that version after hashing them and comparing with the version identifier.
      Line numbers computed against today's file for yesterday's citation point at plausible, wrong
      code, and nothing about a wrong line number looks wrong — so a mismatch refuses rather than
      answering. A citation also says whether it was resolved to the cited span or widened to the
      whole chunk, because a wide citation that looks precise is its own small dishonesty.

      **The call graph respects repository boundaries by construction.** Payments calls into
      platform, so "who calls `withRetry`" has an answer a platform-only principal may not see.
      Filtering at query time would have needed `canRead`, which `governance` deliberately does not
      export — so the graph never records an edge that crosses a repository, and every edge it holds
      joins two symbols in one access zone. The cost is stated and counted: the fixture's two real
      cross-repository calls are dropped for everybody, including a principal entitled to both
      sides, and `crossRepositoryCalls` reports it.

      **The compiler attaches a file's header comment to the first declaration**, found on the first
      run when an interface was cited from line 1. A doc comment separated from its declaration by a
      blank line now belongs to nothing, which matches how people write them and has a test.

      **Labels are keyed by symbol and resolved after ingestion**, because chunk identifiers derive
      from bytes and a reformat moves them all. That claim was tested by accident and held: Prettier
      reformatted the fixtures mid-phase, every version identifier changed, and the evaluation and
      the citations came back identical. A label naming a symbol that no longer exists throws rather
      than scoring zero.

      ADR 0007 records the `typescript` dependency, confined to this exhibit. Not done, and said in
      the README: no commit history (there is no version-control connector, and a fake one would be
      worse than the gap), and call edges are syntactic — an edge can be missing, never invented.

- [x] **P17a — `packages/sandbox`: the platform constructed in memory, promoted once.** The
      in-memory construction of stores, indexes, stand-in models and both pipelines that six places
      currently copy, promoted into one package with a defined contract. Implements PRD 11.2's rule
      that a helper two consumers need is "promoted into a package with a defined contract — a
      deliberate, reviewed act". Acceptance: a new package at a new layer between `composition`
      and the runtime groups, declared in `layers.json` with an ADR; it uses `model-gateway`'s
      existing `fakeEmbedder` rather than becoming a seventh copy of the stand-in; `rag-02-codebase`
      moves onto it, so the promotion has a consumer on the day it lands rather than a promise of
      one; it is named for what it is — never for a deployment — and a test says so.

      Done. 9 tests in the package, and RAG-02's 22 unchanged. The boundary was demonstrated in the
      direction that matters: `composition` importing the sandbox produced `forbidden-import` and a
      `dependency-cycle`, and removing it returned exit 0. ADR 0008 records the new layer.

      **The obvious home was ruled out by a sentence I wrote.** Composition's charter is "this
      package assembles; it does not construct", and that sentence is the one thing stopping the
      only package allowed to import everything from absorbing everything. Loosening it would have
      been one line in a comment, and it would have been the decay ADR 0005 exists to prevent, done
      by its own author one phase later. A package that constructs and a package that assembles
      fail differently — a wrong object against two right objects wired wrongly — and keeping them
      apart keeps each reviewable.

      **It ends a seventh copy before it starts, and uses the one that already existed.** Six places
      had written out the same stand-in embedder while `model-gateway` exported `fakeEmbedder`,
      which is that embedder. The sandbox uses `fakeEmbedder`.

      **RAG-02 moved onto it in the same change**, losing about fifty lines, and came back with
      identical tests and an identical evaluation — recall@5 0.80, MRR 0.7667. A promotion with no
      consumer is a guess about what the next consumer will need; this one had its first on the
      day it landed.

      **Named so nobody mistakes it for a deployment.** Every model identifier it records begins
      `stand-in`, and there are tests on the audit record and the chunk embedding reference as well
      as on the constant. The failure the name guards against is the quiet one: a convenience
      package somebody points at a real model one day, after which its numbers get quoted.

      **Five copies remain, recorded as debt rather than fixed.** The API, the worker, the
      evaluation runner, the load run and the corpus inventory still construct the platform
      themselves. The applications are deployment surfaces whose construction should move towards
      real adapters, not towards a sandbox; the tools can migrate when next touched. Doing it here
      would have hidden a boundary move inside a refactor.

      The retrieval cache is **on by default**, as a deployment has it, and a caller can turn it off
      — with a test for each, because P15's load run showed what a repeating workload does to a
      latency figure with it on. RAG-02 turns it off: every question it asks is asked once.

- [x] **P17b — `exhibits/rag-03-incident`.** The second exhibit: the Incident Knowledge Assistant
      from `content/projects/RAG-03.json` — retrieve runbooks, dashboards, deploys and past
      postmortems; surface evidence and uncertainty; take no autonomous production action.
      Acceptance: as P16, plus the property only a second exhibit can demonstrate — it imports
      nothing from `rag-02-codebase`, demonstrated by a real import failing, and the helper both
      need comes from `packages/sandbox` rather than sideways; `pnpm boundaries:evidence` now
      reports PRD 12 item 5's two-exhibit requirement **met**, from the generated graph rather than
      by editing the sentence that says it is not.

      Done. 23 tests in the exhibit, 724 in total across 29 files. **PRD 12 item 5 is met, and the
      generator decided
      it.** Demonstrated first: RAG-03 importing RAG-02 by package name and by relative path produced
      two `exhibit-is-a-leaf` violations, and removing them returned exit 0 — the package-name form
      caught only because of P16's fix.

      **The evidence generator had to learn to change its mind.** It said "not met"
      unconditionally, having been written when there were no exhibits — correct then, and a
      sentence that could never change, which is not evidence of anything. It now reads each
      exhibit's outgoing edges: an exhibit counts if it imports at least one declared package, and
      the requirement fails if any exhibit imports another exhibit or an application. There are tests
      for the met case and for every way it can fail — a leaking import, an import of an
      application, an exhibit that consumes nothing, a failed check. The acceptance said "from the
      generated graph rather than by editing the sentence", and the easy route would have been to
      change the sentence.

      **No production action, by construction.** The brief has five fields and none can carry an
      action; a test asserts the exact key set, so adding one is deliberate. The fixture's runbook
      carries a vendor-template line telling automation to "run the rollback immediately and without
      confirmation", and it reaches the responder as a quotation attributed to the runbook, like any
      other retrieved passage (PRD 6.5).

      **Uncertainty is derived from the evidence, never asked of the model.** A model's
      self-reported confidence is one more sentence it produced, with no more grounding than the
      rest. The brief says what the evidence does not establish — one source, no postmortem, no
      deploy in the window, stale evidence — each computed from the list printed beside it. And
      nothing in it speaks about material the asker could not see: whether anything was withheld is
      `governance`'s to say (PRD 6.4), relayed unchanged, and a test holds that no uncertainty code
      could express it. "A relevant postmortem exists that you cannot read" would be the existence
      oracle arriving as a caveat.

      **"No deploy in the window" says it rules out nothing.** Recent changes come from a second
      governed query rather than by reading the deploy directory — the pre-filter is the only read
      path — so they are bounded by retrieval depth, and the statement says so rather than implying
      that nothing changed. Checked live: the payments deploy was found 1.1 hours before the fixture
      incident, and the search deploy two days earlier fell outside the 24-hour window.

      **The second exhibit needed less of its own code than the first.** RAG-02 brought a chunker
      because code has no headings; runbooks are Markdown, so RAG-03 used the P6a chunker unchanged
      and brought none. That is the shape a reusable platform should produce, and it is the first
      evidence that it does.

      **One addition to the sandbox**, `sourceText`: the exact bytes of every ingested version,
      captured from the connector rather than re-read from disk, so a document is dated from what was
      indexed rather than what is there now. It is unfiltered like `chunks.all()`, documented as
      usable only to annotate a result the pre-filter already returned, and RAG-03 uses it only that
      way — to date a document the principal received.

      **What the two exhibits deliberately do not share:** their label resolvers. Both resolve
      human-meaningful labels to chunk identifiers and then score with `evalkit`, and the scoring is
      already the shared package. What differs is what a label means — a symbol in a source file, a
      section of a runbook — and a helper that knew both would be two exhibits' concerns leaking into
      one package. PRD 11.2 promotes what two consumers need; it does not merge what two consumers
      happen to write similarly.

      **Why P17 is split.** The acceptance asked for a helper both exhibits need to be promoted
      rather than copied, and there is one: the in-memory construction of the whole platform, which
      six places already copy — the API, the worker, the evaluation runner, the load run, the corpus
      inventory and RAG-02 — each with its own identical stand-in embedder, while `model-gateway`
      exports `fakeEmbedder`, which does the same thing. The obvious home is `composition`, and its
      own charter rules it out: "this package assembles; it does not construct" (ADR 0005). That
      rule is what stops the one package allowed to import everything from absorbing everything, so
      the promotion needs a package of its own, at a layer of its own, with an ADR — which is a
      boundary change, and a boundary change should not be buried in a commit that also adds an
      exhibit.

- [x] **P18a — Real models, selectable where evidence is produced.** The evaluation runner and the
      load run choose their model set by configuration — the stand-ins, or the OpenAI adapter from
      P13 — and every artefact records which. Implements the half of PRD 12 items 2 and 4 that says
      the report is "against the reference profile", which pins model identifiers. Acceptance:
      `--models openai` constructs the P13 adapters and the dated price table, and refuses to start
      without `OPENAI_API_KEY`, naming the variable; the reranker stays the stand-in and the artefact
      says it is unselected rather than inventing one; the stand-ins remain the default, so no
      command spends money unless asked to; tests drive the real-model path through the recorded
      transport, and none reaches the network.

      Done. 744 tests across 29 files. `pnpm app:eval -- --models openai` and
      `pnpm loadrun -- --models openai` now construct the P13 adapters and the dated price table;
      without `OPENAI_API_KEY` both refuse before ingesting a byte, naming the variable. Stand-ins
      stay the default. **No live call has been made**: the key was reported added, but it is not
      visible to this session's processes at process, user or machine scope, and the phase does not
      need it.

      **The query embedding had never been priced.** Wiring the real set exposed that the
      dense-retrieval span ended without a model record — the query embedding's tokens and cost
      went nowhere, and the rerank span was the same. A request's cost would have been its
      generation alone, understating PRD 9.3's cost per answer by exactly retrieval's share, with
      real prices in the table and nothing to show the gap. Both spans now record their model call,
      priced from the same table grounding uses, which composition passes to both.

      **The unselected reranker could have made cost unmeasurable forever.** Every run uses the
      stand-in reranker because no rerank model is selected, and it is unpriced — so "any unpriced
      call makes the request's cost unknown" would null every request for a reason that has nothing
      to do with cost. Treating it as costing zero would break ADR 0002 in spirit. The rule is:
      any unpriced call nulls the request, except the local stand-in reranker **by name**, and every
      cost figure carries a caveat that it excludes reranking and that a selected rerank model would
      add its own price. It is excluded by name so that nothing else can slip through with it.

      **The p50 cost budget would have been measured at p95.** The first version of the load run's
      measurement took p95 of every row, harmless while every cost row was unmeasured and wrong the
      moment one became measurable. Each budget now declares its percentile, with a test that the
      two cost budgets report different numbers from the same run.

      **A field named `ingestionEmbeddingTokens` held the chunk count.** Never printed, and wrong
      regardless; it is now the embedder's own usage figure, which the ingestion pipeline was
      already summing. Found by reading what P18b would divide by.

      **JSON mode on the generator.** Grounding's prompt asks for a JSON object in words, and a model
      that honours the request but wraps the object in a Markdown fence produces text `JSON.parse`
      rejects — every answer would fail verification for a formatting reason, and the first real
      evaluation would have measured code fences. JSON mode removes the fence without loosening the
      parser.

      Cost per answer counts **answered** queries only, per PRD 9.3's wording: an abstention costs
      less, and folding it in would lower the figure for a reason unrelated to answering.

- [x] **P18b — Complete artefacts, from real runs, published.** Every field PRD 12 items 2 and 4
      name, present in the artefact rather than assumed: the raw per-query result file, seeds, run
      count and prompt versions for the evaluation; the raw span export and the versioned price table
      for the cost and latency report. Then the real runs — `--models openai` for both — with their
      artefacts published to a committed directory, because a promotion needs evidence a reviewer can
      open by URL and `evidence/` is a gitignored working directory. Acceptance: each required field
      is present in a machine-readable artefact and a test asserts the writer emits it; nothing is
      recorded that the run did not produce; the real-run findings — including the ones that do not
      flatter — are written where they will be read.

      **Why P18b is split again.** The first real evaluation showed its artefacts were incomplete
      against PRD 12's own list: per-query results existed only inside a Markdown report, and seeds,
      run count, the answering prompt's version, the load run's price table version and its raw span
      export were not recorded anywhere. A verdict generator reading those artefacts would have to
      either fail item 2 and item 4 for missing fields, or be written to overlook them. Completing the
      artefacts first means the verdict phase reads evidence rather than excusing its absence.

      Done. 752 tests across 29 files. The real evaluation is published in `docs/evidence/` citing
      commit `a76f16b`, and the real load run in `docs/measurements/` citing `dd00811`, each the
      commit that produced it — the code that writes the artefacts was committed before the runs,
      so no artefact cites code that did not contain its writer. Both use `text-embedding-3-small`
      and `gpt-4.1-mini` at price table `openai-2026-09-24`; the reranker and the judge remain
      stand-ins and every artefact names them as such. The artefacts were checked for key and
      organisation-id fragments before commit, because this repository is public.

      **Getting to a real run took four fixes, each found by the provider rather than by a test.**
      The first live call was answered `insufficient_quota` with HTTP 429, which the adapter had
      classified as a rate limit and would have retried three times — an empty balance is not
      transient. The first successful call echoed a dated snapshot, `gpt-4.1-mini-2025-04-14`, that
      no price list names; pricing now goes by the model requested and the snapshot is reported.
      The first real evaluation died on a transient failure from the answer path, and PRD 9.4's
      "generation unavailable" degraded mode turned out not to exist — recorded as a limitation, not
      fixed in an evidence phase. And the first real load run hit a 200,000-tokens-per-minute limit
      whose response said "try again in 338ms", against a retry schedule that waited 100 ms then
      200 ms: tuned against a fake that never rate-limits, it could not succeed against any real
      limit longer than itself. It now honours the provider's requested wait, capped at thirty
      seconds. Lowering the concurrency until the error went away was the rejected alternative; it
      would have hidden a real property of the reference profile.

      **The served configuration is the worst fused arm.** With real embeddings, the ablation puts
      `fused-with-rerank` at nDCG@10 0.71 against 0.87 with reranking bypassed and 0.95 dense-only.
      The reranker is the unselected stand-in: harmless while everything else was a stand-in, and
      the weakest link once nothing else was. It was not "fixed" here by changing the served
      default — choosing a configuration on eleven development items and then quoting those same
      items would be overfitting presented as a result. It is in `docs/limitations.md` as the first
      decision anybody promoting this should make, with a held-out run to confirm it.

      **What the real models established that the stand-ins could not.** Correct-abstention 1.0 over
      4 (0 with the stand-ins), citation precision 0.83 and span-validity 1.0 on the served arm, and
      zero leaks and zero existence disclosures with real models in the loop. Retrieval metrics
      reproduced exactly across two real runs.

      **The latency budget holds by the width of the cache.** End-to-end p95 is 2,914 ms against a
      3,000 ms budget, but 247 of 260 requests hit the retrieval cache; the thirteen misses have a
      p95 of 3,597 ms — the slowest of thirteen, and over budget. Generation is almost all of it. The
      record's `caveat` field says which population dominates, and `docs/limitations.md` says the
      cache-miss number is the one that describes answering a question.

      **Cost is inside budget by a wide margin and qualified.** p50 $0.00082 and p95 $0.00172 per
      answered query against $0.02 and $0.06, ingestion $0.001 per thousand chunks against $0.50 —
      every figure excluding reranking, which a selected rerank model would add. Retrieval-only cost
      reads zero, and that is the cache again: 95% of requests never embedded a query.

      Recorded rather than resolved: 49 abstentions under load where the workload's unanswerable
      queries account for 40, so nine answerable requests were refused; how many requests waited on
      the rate limit is not in the export; and time to first token remains unmeasurable without
      streaming.

- [x] **P18c — The verdict, and a proposal or a refusal.** Decide each PRD 12 item met or unmet with
      a generator that reads the published artefacts, rather than in prose; rewrite
      `docs/promotion-readiness.md` from its output. Acceptance: the verdict for every item comes
      from a generated artefact; if and only if all seven hold, the phase writes a **proposed**
      manifest edit into `docs/promotion/` — as a file in this repository, for review — listing every
      field PRD 12 requires with the value the artefacts support; the portfolio's
      `content/projects/RAG-01.json` is still not touched from here, and no number is promoted that
      its artefact does not contain.

      **A refusal remains an acceptable outcome.** If the artefacts do not support `measured`, this
      phase says so again and the proposal is not written. P12 already established that the
      honest result of an evidence phase can be "no".

      Done (ADR 0009). 798 tests across 30 files. `tools/readiness` decides all seven items from the
      committed artefacts, imports nothing but Node built-ins and its own files (checked by a test
      that reads its sources), and `pnpm readiness:check` joins `pnpm verify`, re-rendering both
      outputs and failing on any difference — demonstrated against a hand edit and a deleted
      proposal. **All seven items are met**, so `docs/promotion/RAG-01.proposed.json` exists: status
      `in-progress` (the limitations list records PRD 9.4's degraded mode as unimplemented),
      `proofLevel: measured`, 18 metrics each with a JSON pointer into its artefact, 7 evidence
      entries, and every excluded metric listed with its reason. **Nothing is promoted**: the
      portfolio manifest was not touched, and `integrity.reviewedBy` is left for a person.

      The generator's first run failed two items, and both findings were real. The threat model
      cited a test that does not exist; the price-table version was a template literal no search
      could find. Both were fixed at the source, not by loosening the check. A third defect, found
      by reading the proposal: the limitations list called three model roles real, and two are.

      Recorded, not fixed: `docs/evidence/governance.md` still ends by saying PRD 12's other
      artefacts "remain outstanding" — template text from before P18b. It is a published artefact
      committed byte for byte, and correcting the template without a new paid run would make the
      artefact and its generator disagree.

      **Why P18 is split.** Its acceptance asked for the artefacts "against the real adapter", and
      the real adapter from P13 is wired into nothing that produces an artefact: the evaluation
      runner and the load run both construct stand-ins unconditionally. So even with a key in the
      environment, P18 as written could not have produced the evidence it names. Making the model
      set selectable is its own change with its own failure modes — above all, a command that
      spends money when nobody asked it to — and it has to exist before the verdict can mean
      anything. P18b then runs whichever set is configured and says which it was.

## After promotion

Work done after RAG-01 was promoted to `measured` (portfolio `4df53ab`), each item at a person's
request, not by the loop.

- [x] **P19a — Generation unavailable degrades to ranked passages** (ADR 0010). PRD 9.4's fifth
      degraded mode, missing since P7. It aborted the first held-out evaluation when one answer hit
      the 800-token output limit. A generation `ModelError` now returns the ranked passages with no
      prose, marked degraded in the response and the trace. The harness keeps such queries in the
      per-query file and leaves them out of the answer metrics, so an outage is never scored as a
      decision. Tests cover the fallback, the regeneration path, retries spent, a non-model error
      still throwing, the API response and the harness exclusions.
- [x] **P19b — The held-out evaluation for the reranker decision.** Run the final evaluation at a
      committed SHA, publish it, and report the held-out split's retrieval metrics per arm from its
      per-query files with a tested command. Acceptance: the decision about the stand-in reranker
      is a person's, made on the published held-out numbers; this phase changes no default.

      Done. Published in `docs/evidence/held-out/`, from a real run at `9be9fd5`
      (text-embedding-3-small, gpt-4.1-mini, stand-in reranker and judge). The runner now writes
      `retrieval-by-split.md` whenever it reads held-out. On the three held-out relevance items,
      nDCG@10 is 0.6424 served (fused with rerank), 0.7743 fused without rerank, 0.8221 dense-only
      and 0.6936 lexical-only. Bypassing the reranker beats serving it on rel-012 and rel-013 and
      loses on rel-014 (0.6309 against 1.0000). The direction replicates development; three items
      cannot size it, and no interval is drawn. The development rows reproduce the published P18b
      figures to four decimal places, and an earlier held-out run whose SHA did not match its code
      gave identical retrieval rows.

      The held-out split has now been read twice for this one decision, with nothing changed
      between the reads. Any configuration chosen next can no longer be confirmed on it.

      The fallback from P19a ran for real in this evaluation: generation failed on one dense-only
      query (`prb-004`, a permission probe), which returned its passages and was marked degraded,
      and the run completed. Leak count 0 over 7 probes. What caused that failure is not recorded:
      the per-query record keeps the degraded mark, not the error kind.

- [x] **P19c — Serve fused retrieval with the stand-in reranker bypassed** (ADR 0011). The project
      owner's decision, chosen over dense-only. `RETRIEVAL_DEFAULTS.rerank.enabled` is `false`.
      The served arm is derived from the default by `evalkit`'s `servedArm`, not named in each tool;
      the evaluation records `served: true` on it, and the readiness verdict reads it from there.
      Re-evaluated and re-load-run at `d1b5c50` against real models, as PRD 8.5 requires for a
      reranker change, and published.

      Evaluation: retrieval reproduced the P18b ablation exactly; the served arm has citation
      precision and recall 1.0 and correct abstention 0.75 (1 of 4 answered that should have been
      refused, because no reranker score means no support threshold). The P19a fallback fired
      once in the served arm and once in dense-only, and the run completed.

      Load run: **end-to-end p95 4,634 ms against 3,000 — a breach, accepted rather than fixed.**
      Diagnosed to one workload question whose answer grew to 563–592 tokens; generation's median
      did not move and retrieval got faster. PRD 9.3 allows a regression "explicitly accepted in a
      reviewed change", and until now there was no way to record one except raising the number.
      `docs/measurements/accepted-breaches.json` is that record. `loadrun:check` honours an entry
      only when budget, record commit and value all match, so a re-run lapses it, and a malformed
      entry fails the check. The owner accepted this one; capping answer length was rejected as
      trading completeness for a number, and streaming remains the real fix. _(Corrected in P19d:
      under PRD 7.2 streaming measures the model's first token but cannot deliver it.)_

- [x] **P19d — Stream generation, so time to first token is measured** (ADR 0012). PRD 9.3's
      first-token budget, unmeasurable since P13 because the adapter used the non-streaming endpoint.
      The OpenAI generator now streams server-sent events and times the first content token. The
      caller still receives the whole answer once, verified, because PRD 7.2 allows nothing else, so
      this measures the model rather than what a user sees. Transport gained an optional `stream`;
      grounding exposes `firstTokenAtMs` on its own clock, worked back from when the call returned
      so retry waits cannot skew it; composition now passes its clock to grounding; the load harness
      measures from each request's start. 841 tests.

      Real load run at `cd06e78`: **time to first token 727 ms p95** over 260 requests, within
      1,200 — the budget's first measurement. Two breaches, both accepted by the owner for this
      record only: end-to-end p95 4,756 ms (the same long-answer question as P19c; the acceptance
      corrects the earlier claim that streaming would help), and **retrieval stage p95 564 ms
      against 400**, which is new. Retrieval runs only on the 13 cache misses, so its p95 is the
      slowest one, an embeddings call. The retrieval code did not change, and re-running until it
      fit was rejected. The budget needs more cache-miss samples before it means anything.

      A correction to the limitations list, made along the way: it called only streaming
      unimplemented, so building it would have flipped the readiness status to `complete` while
      PRD 10's shared corpus store is not implemented either. It now says so in plain words.

## What this build does not do

P12 produces the evidence. It does **not** edit `content/projects/RAG-01.json` in the portfolio
repository. PRD 12 is explicit that promotion is a reviewed human act and that no number from the
specification may be restated as an achievement until the artefacts exist. The loop stops at the
evidence.

That still holds through P18. The furthest this repository goes is a proposed manifest edit,
written here as a file to be read and applied by a person. A project that could promote itself
would be a project whose proof level means nothing.
