# RAG-02 — Codebase Intelligence Assistant

Answers questions about a codebase with **line-level citations into a specific version of a file**,
and respects **repository boundaries**: a principal who may not read a repository gets nothing from
it — not a retrieved chunk, and not a call-graph edge.

It is built on `packages/*` and changes none of them. That is the point of it as much as the
features are.

```bash
pnpm exhibit:rag-02 -- --principal prn_dev "how is the retry backoff delay computed"
pnpm exhibit:rag-02 -- --evaluate
```

## What it adds, and what it reuses

| Adds (this exhibit)                          | Reuses (`packages/*`, unchanged)                     |
| -------------------------------------------- | ---------------------------------------------------- |
| A symbol-aware chunker (`symbolAware`)       | Ingestion, the corpus store, change detection        |
| Citations as line ranges pinned to a version | The access manifest and the permission pre-filter    |
| A call graph that never crosses a boundary   | Hybrid retrieval, grounding, verification, the audit |
| Symbol-keyed labels, resolved to chunks      | `evalkit`'s recall@k and MRR                         |

**The chunker plugs into `ingest` through its `ChunkStrategy` interface.** One chunk per top-level
declaration, doc comment included, cut between lines when a declaration is over budget. The
platform's structure-aware chunker is for prose: on a TypeScript file every chunk boundary would
land wherever the token budget ran out, often between a signature and its body. See ADR 0007 for the
parser.

**A citation is `platform/retry.ts:17-18 @ sv_…`**, and the line numbers are computed from the exact
bytes of that version — which are hashed and compared with the version identifier first. Line numbers
computed against today's file for yesterday's citation would point at plausible, wrong code.

**The call graph never records an edge across a repository.** Payments calls into platform, so "who
calls `withRetry`" has an answer in a repository `prn_dev` may not read. Rather than record the edge
and filter it — which would need an authorisation check `governance` deliberately does not export —
the graph never contains it. Every edge joins two symbols in one access zone, so whoever may read
one end may read the other.

## The fixture

Two repositories in two access zones:

| Repository  | Readable by       | Files                      |
| ----------- | ----------------- | -------------------------- |
| `platform/` | `grp_engineering` | `retry.ts`, `http.ts`      |
| `payments/` | `grp_payments`    | `refunds.ts`, `reserve.ts` |

`prn_dev` reads platform only. `prn_payments` reads both. `payments/refunds.ts` calls
`withRetry` and `postJson` in platform — the two cross-repository calls the graph drops, and counts.

## What this does not do

- **No real model.** The embedder, reranker and generator are the platform's stand-ins, so the
  answer text is a quotation rather than an explanation. What is real is which code is cited, where
  the lines are, and what a principal is allowed to see.
- **No history.** RAG-02's summary lists history, and there is no version-control connector here.
  Indexing commit history is a connector the platform does not have, and a fake one would be worse
  than the gap.
- **No cross-repository call edges** — for anybody, including a principal entitled to both sides.
  That is the cost of enforcing the boundary by construction, and `crossRepositoryCalls` reports it.
- **Call edges are syntactic.** A call is matched by name, not resolved by a type checker, so an edge
  can be missing but never invented.
- **Evaluation numbers measure a stand-in** over a four-file fixture labelled by its author. They
  show the evaluation runs against symbol-keyed labels; they say nothing about retrieval quality.

## Why labels are keyed by symbol

A chunk identifier is derived from a file's bytes, so reformatting a file moves every identifier in
it. A symbol — `withinWindow` in `payments/refunds.ts` — is what actually answers a question about
code, and a label keyed on it survives an edit that does not change which declaration answers. Labels
are resolved to chunk identifiers after ingestion, and a label naming a symbol that no longer exists
fails the evaluation rather than silently scoring zero.
