# AtlasOps

A governed knowledge platform: versioned sources in, grounded and cited answers out, with access
control enforced in the retrieval query rather than after it, and quality, cost and latency
measured rather than asserted.

This repository is **RAG-01**, the Track 14 keystone of an engineering archive, and it will also
host the fourteen focused exhibits RAG-02 … RAG-15 from the same track.

## Status

Nothing is built yet. The specification exists and the build has not started.

That sentence is load-bearing. The archive this project belongs to forbids inventing metrics,
performance results, repository history or external validation, so until a measurement has actually
been taken there is no number here to quote. Every threshold in the specification is a target with
a stated measurement method attached, never a result.

## Where to start reading

| Document                                                     | What it is                                          |
| ------------------------------------------------------------ | --------------------------------------------------- |
| [`docs/prd/RAG-01-atlasops.md`](docs/prd/RAG-01-atlasops.md) | The specification. Section 11 is the module layout. |
| [`docs/PHASES.md`](docs/PHASES.md)                           | The build plan, and the bar every phase must meet.  |
| `docs/adr/`                                                  | Decisions, once there are any to record.            |

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
