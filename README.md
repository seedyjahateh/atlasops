# AtlasOps

A governed knowledge platform: versioned sources in, grounded and cited answers out, with access
control enforced in the retrieval query rather than after it, and quality, cost and latency
measured rather than asserted.

This repository is **RAG-01**, the Track 14 keystone of an engineering archive, and it will also
host the fourteen focused exhibits RAG-02 … RAG-15 from the same track.

## Status

Built through phase P12, and **not promoted**. [`docs/promotion-readiness.md`](docs/promotion-readiness.md)
checks the seven artefacts the specification requires before promotion, finds two this repository cannot
produce, and records the verdict: not ready. The manifest stays at `proofLevel: "code"`.

What exists: eleven packages — ingest, indexing, retrieval, grounding, model-gateway, governance, telemetry,
evalkit, composition, contracts, corpus — and 554 tests across 21 files, run in CI alongside type checks, lint,
formatting and the module-boundary check.

What that does not mean: there is still no quality, cost or latency number to quote here. The archive this
project belongs to forbids inventing metrics, performance results, repository history or external validation, so
a threshold in the specification stays a target with a measurement method attached until a measurement has been
taken _and_ its evidence is complete. Later phases did produce numbers; `docs/promotion-readiness.md` is where
it is written down that none of them may yet be restated as an achievement.

That distinction is load-bearing, and it is why this section says "built" rather than "done".

## Where to start reading

| Document                                                     | What it is                                             |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| [`docs/promotion-readiness.md`](docs/promotion-readiness.md) | Why this is not promoted yet, artefact by artefact.    |
| [`docs/prd/RAG-01-atlasops.md`](docs/prd/RAG-01-atlasops.md) | The specification. Section 11 is the module layout.    |
| [`docs/PHASES.md`](docs/PHASES.md)                           | The build plan, and the bar every phase must meet.     |
| [`docs/MODULES.md`](docs/MODULES.md)                         | The generated module table.                            |
| [`docs/limitations.md`](docs/limitations.md)                 | What this does not do, and what it is not evidence of. |
| [`docs/threat-model.md`](docs/threat-model.md)               | What is trusted, and what is assumed hostile.          |
| [`docs/adr/`](docs/adr/)                                     | Five decisions, each recorded where it was made.       |

The specification's canonical copy lives in the portfolio repository at
`docs/prd/projects/RAG-01-atlasops.md`. The copy here is the working reference; if the two ever
disagree, the portfolio copy wins.

## The one structural rule

Dependencies flow downward through the layers declared in `tools/boundaries/layers.json`, the graph
stays acyclic, and **exhibits are leaves** — nothing imports an exhibit, so any one of the fourteen
can be read, run, deleted or published on its own.

That is not a convention. It is checked by `pnpm boundaries:check` in CI, because a convention this
load-bearing decays the first time someone is in a hurry, and two months later there is no exhibit
that can be understood alone.
