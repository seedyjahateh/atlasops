# ADR 0008 — A sandbox layer for the platform constructed in memory

- **Status:** accepted
- **Date:** 2026-09-24
- **Amends:** ADR 0005 (the composition layer) — by adding a layer above it, not by changing it

## Context

Before this decision, six places constructed the whole platform in memory by hand: the API, the
ingestion worker, the evaluation runner, the load run, the corpus inventory, and RAG-02. Each built
the same stores, indexes and pipelines, and each wrote out its own copy of the same stand-in
embedder — while `model-gateway` already exported `fakeEmbedder`, which is that embedder.

P17 required the second exhibit to take the helper both exhibits need from a package rather than
from each other, and this construction is that helper. PRD 11.2 names the procedure: "promote it
into a package with a defined contract — a deliberate, reviewed act".

The obvious home is `composition`, the one package allowed to import everything below it. Its own
charter rules it out: **"this package assembles; it does not construct"** (ADR 0005). Composition
takes an index, a gateway, a store as values somebody else built, which is what lets a deployment
hand it real services without a line of it changing. That rule is also what stops the one package
permitted to import everything from absorbing everything.

## Decision

A new package, `@atlasops/sandbox`, at a new layer 9 named `sandbox`, between `composition` (8) and
the runtime groups (now 10). It constructs the in-memory stores and indexes, the stand-in models
(`fakeEmbedder`, `fakeReranker`, `citingStandIn`), and both pipelines through `composition`.

It may import `composition` and everything below it except `evalkit`, which it does not need.
Nothing below it may import it — demonstrated: `composition` importing it produced `forbidden-import`
and a `dependency-cycle`, and removing the import returned exit 0.

## Why a new layer rather than a looser composition

Loosening composition's charter would have been one line in a comment. It would also have been the
decay ADR 0005 was written to prevent, done by the author of that ADR one phase later, for
convenience. A package that constructs and a package that assembles fail differently: a construction
bug is a wrong object; an assembly bug is two right objects wired wrongly. Keeping them apart keeps
each reviewable, and it keeps the statement "composition never constructs" true enough to rely on.

## Why the name

`sandbox` says what it is for. Every store is in-process and every model identifier it records
begins `stand-in`, and a test asserts both. A deployment constructs real adapters and hands them to
`composition` directly. The failure this name exists to prevent is the quiet one: a convenience
package that somebody, one day, points at a real model, after which its numbers get quoted.

## Consequences

**What it buys.** One construction of the platform for exhibits instead of one per exhibit, built on
`model-gateway`'s existing stand-in rather than a new copy. RAG-02 moved onto it in the same change,
losing about fifty lines, and its 22 tests and its evaluation came back identical — the promotion
has a consumer on the day it lands rather than the promise of one.

**What it costs.**

_One more layer._ Eleven, where there were ten. Each layer is a rule somebody has to understand,
and this one exists to protect a distinction — assemble versus construct — that a reader has to be
told about to see.

_Five copies remain._ The API, the worker, the evaluation runner, the load run and the corpus
inventory still construct the platform themselves. That is recorded as debt rather than fixed here:
the applications are deployment surfaces whose construction should move towards real adapters, not
towards a sandbox, and the tools are free to migrate when they are next changed. Nothing about this
decision requires them to, and doing it in the same change would have hidden a boundary move inside
a refactor.

_A dependency on `composition` from a package._ Until now only the runtime groups depended on it.
The sandbox is the first package to, which is exactly why it sits at a layer of its own above it.
