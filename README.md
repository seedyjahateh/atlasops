# AtlasOps

A governed knowledge platform: versioned sources in, grounded and cited answers out, with access
control enforced in the retrieval query rather than after it, and quality, cost and latency
measured rather than asserted.

This repository is **RAG-01**, the Track 14 keystone of an engineering archive, and it will also
host the fourteen focused exhibits RAG-02 … RAG-15 from the same track.

## Status

Every phase in [`docs/PHASES.md`](docs/PHASES.md) is built, and the project is **proposed for
promotion, not promoted**. [`docs/promotion-readiness.md`](docs/promotion-readiness.md) is generated
by `pnpm readiness` from the published artefacts and finds all seven items the specification
requires met. It therefore wrote
[`docs/promotion/RAG-01.proposed.json`](docs/promotion/RAG-01.proposed.json): a manifest edit for a
person to review and apply in the portfolio repository, which nothing here writes. Until that edit
is made, the manifest stays at `proofLevel: "code"`.

What exists: twelve packages (contracts, telemetry, governance, model-gateway, corpus, ingest,
indexing, retrieval, grounding, evalkit, composition, sandbox), four applications (answer API,
ingestion worker, evaluation runner, console), and two exhibits (RAG-02 codebase, RAG-03 incident).
There are 798 tests across 30 files, and CI runs them alongside type checks, lint, formatting, the
module-boundary check, and checks that the corpus inventory, the datasets, the load-run budgets and
the readiness verdict agree with what is committed.

The evaluation and load run in [`docs/evidence/`](docs/evidence/) and
[`docs/measurements/`](docs/measurements/) used real models for embedding and generation. The
judge is still a stand-in, and the served configuration bypasses the stand-in reranker (ADR 0011);
every artefact names both. No number from them is quoted here: the specification allows that only
after the reviewed promotion, and [`docs/limitations.md`](docs/limitations.md) records what the
numbers do not support. In particular, without a reranker, refusing unanswerable questions is left
to the generator, and the end-to-end latency budget is breached — an explicit, reviewed acceptance
in [`docs/measurements/accepted-breaches.json`](docs/measurements/accepted-breaches.json), not a
raised target.

## Where to start reading

| Document                                                     | What it is                                             |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| [`docs/promotion-readiness.md`](docs/promotion-readiness.md) | The generated verdict, artefact by artefact.           |
| [`docs/promotion/`](docs/promotion/)                         | The proposed manifest edit, awaiting review.           |
| [`docs/prd/RAG-01-atlasops.md`](docs/prd/RAG-01-atlasops.md) | The specification. Section 11 is the module layout.    |
| [`docs/PHASES.md`](docs/PHASES.md)                           | The build plan, and the bar every phase must meet.     |
| [`docs/MODULES.md`](docs/MODULES.md)                         | The generated module table.                            |
| [`docs/limitations.md`](docs/limitations.md)                 | What this does not do, and what it is not evidence of. |
| [`docs/threat-model.md`](docs/threat-model.md)               | What is trusted, and what is assumed hostile.          |
| [`docs/adr/`](docs/adr/)                                     | Nine decisions, each recorded where it was made.       |

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
