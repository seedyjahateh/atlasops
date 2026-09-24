# Boundary enforcement

- **Commit:** dd00811
- **Generated:** 2026-09-24T18:10:42.494Z

## Check result

`pnpm boundaries:check` passed over 144 source file(s) in 12 declared module(s) and 640 import(s).

Two mechanisms enforce the same rule and are generated from one manifest: a
`no-restricted-imports` zone per package, which fails `pnpm lint` at the file that wrote the
import, and this checker, which walks the resolved graph and catches what lint cannot —
transitive edges, imports reached through re-exports, and cycles.

## Module graph

Edges between declared modules, deduplicated and sorted. Emitted as text rather than as a
picture so that a pull request shows a module acquiring a dependency as a diff.

```text
@atlasops/composition -> @atlasops/contracts
@atlasops/composition -> @atlasops/corpus
@atlasops/composition -> @atlasops/evalkit
@atlasops/composition -> @atlasops/governance
@atlasops/composition -> @atlasops/grounding
@atlasops/composition -> @atlasops/indexing
@atlasops/composition -> @atlasops/ingest
@atlasops/composition -> @atlasops/model-gateway
@atlasops/composition -> @atlasops/retrieval
@atlasops/composition -> @atlasops/telemetry
@atlasops/corpus -> @atlasops/contracts
@atlasops/corpus -> @atlasops/governance
@atlasops/evalkit -> @atlasops/contracts
@atlasops/evalkit -> @atlasops/governance
@atlasops/evalkit -> @atlasops/grounding
@atlasops/evalkit -> @atlasops/retrieval
@atlasops/evalkit -> @atlasops/telemetry
@atlasops/governance -> @atlasops/contracts
@atlasops/governance -> @atlasops/telemetry
@atlasops/grounding -> @atlasops/contracts
@atlasops/grounding -> @atlasops/governance
@atlasops/grounding -> @atlasops/model-gateway
@atlasops/grounding -> @atlasops/retrieval
@atlasops/grounding -> @atlasops/telemetry
@atlasops/indexing -> @atlasops/contracts
@atlasops/indexing -> @atlasops/corpus
@atlasops/indexing -> @atlasops/governance
@atlasops/ingest -> @atlasops/contracts
@atlasops/ingest -> @atlasops/corpus
@atlasops/ingest -> @atlasops/governance
@atlasops/ingest -> @atlasops/model-gateway
@atlasops/ingest -> @atlasops/telemetry
@atlasops/model-gateway -> @atlasops/contracts
@atlasops/model-gateway -> @atlasops/telemetry
@atlasops/retrieval -> @atlasops/contracts
@atlasops/retrieval -> @atlasops/governance
@atlasops/retrieval -> @atlasops/indexing
@atlasops/retrieval -> @atlasops/model-gateway
@atlasops/retrieval -> @atlasops/telemetry
@atlasops/sandbox -> @atlasops/composition
@atlasops/sandbox -> @atlasops/contracts
@atlasops/sandbox -> @atlasops/corpus
@atlasops/sandbox -> @atlasops/governance
@atlasops/sandbox -> @atlasops/grounding
@atlasops/sandbox -> @atlasops/indexing
@atlasops/sandbox -> @atlasops/ingest
@atlasops/sandbox -> @atlasops/model-gateway
@atlasops/sandbox -> @atlasops/retrieval
@atlasops/sandbox -> @atlasops/telemetry
@atlasops/telemetry -> @atlasops/contracts
apps/api -> @atlasops/composition
apps/api -> @atlasops/contracts
apps/api -> @atlasops/corpus
apps/api -> @atlasops/governance
apps/api -> @atlasops/grounding
apps/api -> @atlasops/indexing
apps/api -> @atlasops/ingest
apps/api -> @atlasops/model-gateway
apps/api -> @atlasops/retrieval
apps/api -> @atlasops/telemetry
apps/eval-runner -> @atlasops/composition
apps/eval-runner -> @atlasops/contracts
apps/eval-runner -> @atlasops/corpus
apps/eval-runner -> @atlasops/evalkit
apps/eval-runner -> @atlasops/governance
apps/eval-runner -> @atlasops/grounding
apps/eval-runner -> @atlasops/indexing
apps/eval-runner -> @atlasops/ingest
apps/eval-runner -> @atlasops/model-gateway
apps/eval-runner -> @atlasops/retrieval
apps/eval-runner -> @atlasops/telemetry
apps/ingest-worker -> @atlasops/composition
apps/ingest-worker -> @atlasops/contracts
apps/ingest-worker -> @atlasops/corpus
apps/ingest-worker -> @atlasops/indexing
apps/ingest-worker -> @atlasops/ingest
apps/ingest-worker -> @atlasops/model-gateway
apps/ingest-worker -> @atlasops/telemetry
exhibits/rag-02-codebase -> @atlasops/contracts
exhibits/rag-02-codebase -> @atlasops/evalkit
exhibits/rag-02-codebase -> @atlasops/governance
exhibits/rag-02-codebase -> @atlasops/ingest
exhibits/rag-02-codebase -> @atlasops/sandbox
exhibits/rag-03-incident -> @atlasops/contracts
exhibits/rag-03-incident -> @atlasops/evalkit
exhibits/rag-03-incident -> @atlasops/governance
exhibits/rag-03-incident -> @atlasops/ingest
exhibits/rag-03-incident -> @atlasops/sandbox
```

## Exhibits

Read from the graph above, not declared: which packages each exhibit imports, and whether it
imports any other exhibit or any application.

| Exhibit | Packages consumed | Imports another exhibit or application |
| ------- | ----------------- | -------------------------------------- |
| `exhibits/rag-02-codebase` | 5 | none |
| `exhibits/rag-03-incident` | 5 | none |

## PRD 12 item 5

Item 5 requires the graph to show **at least two exhibits consuming `packages/*` and importing
no other exhibit**.

**Met.** 2 exhibits consume declared packages and none imports another exhibit or an application, and the check passed. This verdict is computed from the edges each time the artefact is generated; it is not a sentence somebody edited.

The rule is enforced in two forms — an import by relative path and an import by workspace
package name. Until P16 only the first was caught: a package importing an exhibit by its name
resolved as an npm dependency and passed. See `docs/promotion-readiness.md`.
