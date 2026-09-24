# ADR 0006 — The OpenAI adapter has no SDK, and the price table is no longer empty

- **Status:** accepted
- **Date:** 2026-09-24
- **Supersedes nothing. Completes:** ADR 0002 (the price table ships empty)

## Context

Every model in this build was a stand-in. The system ran end to end, and `docs/promotion-readiness.md`
said plainly that its quality numbers measured the stand-ins rather than a retrieval system. PRD 14
left the embedding model and the reranker deliberately open, "to be settled by measurement or by ADR
rather than by assertion in a requirements document". This is that ADR for the first two
capabilities.

The provider is OpenAI, for embeddings (`text-embedding-3-small`, 1536 dimensions) and generation
(`gpt-4.1-mini`). The decision was the repository owner's, because it spends their money: one
vendor, one key, one published price list, and prices low enough that a full evaluation run over
the fixture corpus costs cents.

## Decision

**1. The adapter speaks HTTP directly. No provider SDK is installed.**

`openAiEmbedder` and `openAiGenerator` implement the `Embedder` and `Generator` ports that already
existed, over an `HttpTransport` port, against `/v1/embeddings` and `/v1/chat/completions`.

**2. A second containment rule, keyed on the endpoint host.**

`provider-sdk-outside-gateway` matches import specifiers. A bare `fetch` is not an import, so
without a companion rule the gateway boundary would be enforced against a shape nothing in this
repository uses. `providerEndpoints` in `layers.json` lists the provider hosts, and
`provider-endpoint-outside-gateway` fails any file outside `@atlasops/model-gateway` whose text
contains one. It is required in the manifest rather than optional: an absent block would mean "no
endpoint is restricted", which reads in CI exactly like a passing rule.

**3. `ModelPrice` now requires `source` and `retrievedOn`, and the OpenAI table carries real
prices.**

The figures were read from the vendor's published list at
`https://developers.openai.com/api/docs/pricing` on 2026-09-24 and every entry carries that URL and
that date. The table version is `openai-2026-09-24` — the date, not a sequence number, so a cost
record stamped with it can be re-derived. `UNPRICED_TABLE` remains the default; the priced table is
opted into explicitly.

**4. `fetchTransport` refuses to run under the test runner.**

The standing bar says no test calls a paid API. That is easy to keep by convention and easy to break
by forgetting an argument, so the real transport throws when `VITEST` is set.

**5. One live call, as a command, never in CI.** `pnpm smoke:openai`.

## Consequences

**What this buys.** Nothing above `packages/model-gateway` changed — not one line. The pipeline
cannot tell a real model from a stand-in except by the identifier it records, which is what the
ports were for. Every existing test still runs offline and costs nothing. No new dependency enters
the tree, so there is no SDK to audit, pin or upgrade, and the wire shape is written where a reader
can see it.

**What it costs.**

_Request shaping and error mapping are hand-written._ The SDK would supply both. The mapping is
small (status code to failure kind) and tested, but it is code that only a live call can fully
validate, which is why the smoke command exists.

_Streaming is not implemented._ PRD 9.3 wants time-to-first-token from streaming instrumentation.
Server-sent events over this transport is work P15 will have to do, and an SDK would have given it
away. This is the sharpest edge of the decision and is recorded here rather than discovered there.

_The endpoint rule is blunt._ It matches the host anywhere in a file, including in a comment. The
alternative is deciding which occurrences are load-bearing, which is the judgement that lets the
real one through. Saying "the provider's API" in prose satisfies it.

_`tools/` remains outside the scanned graph._ The smoke command lives there and imports the
gateway. Nothing mechanically stops product code being written in `tools/` and escaping every rule
in this repository. That hole predates this ADR — the checker itself lives there — and it is named
rather than fixed, because scanning `tools/` would require the checker to constrain itself.

_A price list is a snapshot._ Vendors change prices, and a stale table understates or overstates
cost silently. The mitigation is the date on every entry and in the version: when the prices move,
add a new table rather than editing this one, because reports already written cite this version.

**What is still not decided.** The reranker. OpenAI publishes no first-party rerank model, and PRD
5.3's cross-encoder therefore has no adapter. The reranker stays bypassable and unselected, and
every artefact continues to say so. Inventing a reranker identifier to fill the field would be worse
than the gap.
