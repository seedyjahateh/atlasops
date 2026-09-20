# Module boundaries

<!-- Generated from tools/boundaries/layers.json by `pnpm boundaries:table`. Do not edit by hand. -->

Dependencies flow downward only and the graph stays acyclic. `pnpm boundaries:check` enforces
this against the real import graph — not against declared dependencies, which is a different
fact and not the one that decides whether a boundary held.

## Packages

| Layer | Module | Owns | May import |
| --- | --- | --- | --- |
| 0 contracts | `@atlasops/contracts` | Shared types, JSON schemas, error taxonomy, identifier formats | _nothing_ |
| 1 telemetry | `@atlasops/telemetry` | Span model, token and cost accounting, price table, budget assertions | `@atlasops/contracts` |
| 2 platform | `@atlasops/governance` | Principal and group resolution, ACL labels, audit record writing | `@atlasops/contracts`, `@atlasops/telemetry` |
| 2 platform | `@atlasops/model-gateway` | Embedding, rerank and generation interfaces, provider adapters, retries, caching | `@atlasops/contracts`, `@atlasops/telemetry` |
| 3 corpus | `@atlasops/corpus` | Source and SourceVersion model, provenance, corpus store, retention | `@atlasops/contracts`, `@atlasops/telemetry`, `@atlasops/governance` |
| 4 pipeline | `@atlasops/indexing` | Index adapters, schema migration, permission predicate compilation | `@atlasops/contracts`, `@atlasops/telemetry`, `@atlasops/corpus`, `@atlasops/governance` |
| 4 pipeline | `@atlasops/ingest` | Connectors, parsers, chunkers, dedup, change detection, deletion | `@atlasops/contracts`, `@atlasops/telemetry`, `@atlasops/corpus`, `@atlasops/model-gateway`, `@atlasops/governance` |
| 5 retrieval | `@atlasops/retrieval` | Dense arm, lexical arm, RRF fusion, reranking, ablation switches | `@atlasops/contracts`, `@atlasops/telemetry`, `@atlasops/indexing`, `@atlasops/governance`, `@atlasops/model-gateway` |
| 6 grounding | `@atlasops/grounding` | Prompt assembly, answer schema, citation binding, verification, abstention | `@atlasops/contracts`, `@atlasops/telemetry`, `@atlasops/retrieval`, `@atlasops/governance`, `@atlasops/model-gateway` |
| 7 evaluation | `@atlasops/evalkit` | Harness, dataset loaders, metrics, ablation runner, statistics, reporting | `@atlasops/contracts`, `@atlasops/telemetry`, `@atlasops/retrieval`, `@atlasops/grounding`, `@atlasops/governance` |

## Groups

| Layer | Group | Owns | May import |
| --- | --- | --- | --- |
| 8 runtime | `apps/` | Wiring, transport, configuration, deployment surface | any package, no group |
| 8 runtime | `exhibits/` | One exhibit's own code, fixtures, datasets, README, evidence | any package, no group |

## Provider SDKs

Reachable only from `@atlasops/model-gateway`. Everything above
it depends on an interface, which is what lets every downstream test run against the in-repo
deterministic fake instead of a paid API.

Matched patterns: `openai`, `@anthropic-ai/*`, `cohere-ai`, `@google/generative-ai`, `@huggingface/*`, `replicate`, `@mistralai/*`.
