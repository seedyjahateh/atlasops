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

- [ ] **P6 — `packages/ingest`.** Connectors, parsers, chunkers, dedup, change detection, deletion.
      Implements PRD 4.2, 4.3, 4.4 and 4.5. Acceptance: chunk boundaries are deterministic for a
      fixed input; every chunk carries the full 4.4 payload; re-ingesting an unchanged source is a
      no-op; ingestion budgets are asserted against a named fixture corpus.
- [ ] **P7 — `packages/indexing`.** Index adapters, schema migration, and permission predicate
      compilation. Implements PRD 6.2 — the pre-filter. Acceptance: a permission predicate is
      compiled into the index query itself; a post-filter implementation is present only as a
      rejected comparison in tests, proving the pre-filter returns no row the principal may not
      see.
- [ ] **P8 — `packages/retrieval`.** Dense arm, lexical arm, RRF fusion, reranking, ablation
      switches. Implements PRD 5.1 to 5.5. Acceptance: fusion is reciprocal rank, not score
      interpolation, and a test demonstrates why on a case where interpolation misranks; each arm
      can be ablated by configuration; freshness and superseded sources are honoured.
- [ ] **P9 — `packages/grounding`.** Prompt assembly, answer schema, citation binding,
      verification, abstention. Implements PRD 7.1 to 7.3 and 6.5. Acceptance: every returned claim
      binds to a retrieved chunk; an answer that cannot be verified abstains rather than degrading;
      retrieved content is treated as data and a prompt-injection fixture does not change
      behaviour.
- [ ] **P10 — `packages/evalkit`.** Harness, dataset loaders, metrics, ablation runner, statistics,
      reporting. Implements PRD 8. Acceptance: datasets are content-hashed and versioned; a run
      emits the full 8.2 metric table plus per-query raw results; regression detection is
      statistical rather than a threshold on a single number.
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
