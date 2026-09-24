# ADR 0009 — The promotion verdict is generated, and the proposal stays here

- **Status:** accepted
- **Date:** 2026-09-24
- **Reverses:** P12's decision that `docs/promotion-readiness.md` is written by hand, "because it is
  an argument rather than a measurement"

## Context

PRD 12 lists seven artefacts that must exist before RAG-01's manifest may move from `code` to
`measured`. Since P12 the assessment of those seven lived in `docs/promotion-readiness.md`, written
by hand and updated by whichever phase changed an artefact.

It went stale exactly the way a hand-written verdict does. Item 5's section said "not met" for a
phase after the boundary artefact computed "met". Item 4's section still described a load run
against stand-ins after P18b had published one against real models. Nobody lied; the document
simply had no mechanism that made it change when the evidence did.

P18c's specification asks for the opposite arrangement: each item decided "with a generator that
reads the published artefacts, rather than in prose", and a proposed manifest edit only if all seven
hold, written as a file in this repository for review.

## Decision

1. **`tools/readiness` decides the seven items from the committed artefacts**, and
   `docs/promotion-readiness.md` is its output. Each item is a list of findings over named files:
   fields present, counts consistent across files (the per-query file against the declared count,
   the span export against the request count, every arm at the same commit), and references that
   resolve (every test the threat model names exists and contains the named case). Every finding is
   printed, including the ones that hold.

2. **The tool imports nothing but Node built-ins and its own files.** A verdict that imported the
   packages could depend on code that computes rather than on artefacts that record. The test reads
   the tool's own sources and fails on any other import; this is outside the boundary checker's
   reach, because `tools/` builds the checker and is excluded from it.

3. **Every check fails closed.** A missing file, an unparseable one, or one whose shape a check
   does not recognise makes its item unmet. The governance report is Markdown, so the check reads it
   by the patterns its generator writes — which is fragile in a way that errs toward refusal: a
   format change turns item 3 unmet until the check is updated in the same change.

4. **`pnpm readiness:check` joins `pnpm verify`.** It re-renders both files and fails on any
   difference. An artefact that changes without the verdict being regenerated therefore breaks the
   build rather than leaving a verdict about different evidence.

5. **The proposal is a file in this repository, `docs/promotion/RAG-01.proposed.json`, and nothing
   here writes the portfolio's manifest.** PRD 12 requires a reviewed edit. The proposal is written
   only when all seven items hold — `propose` throws otherwise — and the run removes it when they
   stop holding, so it cannot outlive its verdict. Every promoted number carries a JSON pointer into
   its artefact, copied unrounded; the test resolves each one. Every metric the artefacts contain is
   either proposed or excluded with a reason, including those a stand-in measured.

## Consequences

- **A verdict can now be wrong only in a reviewable way**: by a check that is too weak, visible in
  `tools/readiness/verdict.ts`. It cannot drift from the evidence.
- **Its first run found two defects the prose had carried.** The threat model named a test,
  "an empty readable set grants nothing", that does not exist — the real one is "treats an empty
  readable set as nobody, never as everybody". And the price table's version was built from a
  template literal, so no search for the version stamped on the published cost records found the
  table that priced them; it is now a literal, kept equal to the date on every line by a test.
  `docs/limitations.md` also said three of four model roles were real beside a sentence saying two
  were stand-ins; two are real.
- **`dates.started` is the one input not in the files.** The run reads the first commit's date from
  git and records it in the proposal; the check takes it from the committed proposal, because CI
  checks out a single commit and would read the wrong date.
- **Evidence URLs point at `main`.** Pinning them to a commit here would require the commit that
  contains them, which does not exist until this change is committed. The proposal tells the
  reviewer to pin them to the commit they review.
- **Met is a statement about what the artefacts contain, not about quality.** The proposal carries
  the served configuration's nDCG@10 of 0.71, the lowest of the four arms, and a latency budget that holds only on the cache. The reviewer notes say so, computed
  from the same records. Promotion remains a person's decision.
