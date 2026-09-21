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

- [ ] **P10b — `packages/evalkit`: the harness, statistics and reporting.** The ablation runner,
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

- [ ] **P11 — Applications.** `apps/api`, `apps/ingest-worker`, `apps/eval-runner`, `apps/console`.
      Implements PRD 10. Acceptance: the four components run from documented commands; they
      communicate through the corpus store and indexes rather than direct calls; a stalled
      ingestion job does not degrade answer latency, and a test demonstrates that.
- [ ] **P12 — Evidence.** Produce the artefacts PRD 12 requires: the evaluation report, the
      governance report with a zero leak count, the cost and latency report against the 9.1
      reference profile, and the boundary-enforcement artefact showing at least two exhibits
      consuming `packages/*` and importing no other exhibit. Acceptance: every artefact exists and
      is reproducible from a command. Only then may the portfolio manifest be proposed for
      promotion — as a separate reviewed edit, never implied from here.

## What this build does not do

P12 produces the evidence. It does **not** edit `content/projects/RAG-01.json` in the portfolio
repository. PRD 12 is explicit that promotion is a reviewed human act and that no number from the
specification may be restated as an achievement until the artefacts exist. The loop stops at the
evidence.
