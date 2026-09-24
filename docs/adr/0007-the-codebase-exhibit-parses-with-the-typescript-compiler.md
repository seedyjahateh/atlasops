# ADR 0007 — The codebase exhibit parses code with the TypeScript compiler

- **Status:** accepted
- **Date:** 2026-09-24
- **Scope:** `exhibits/rag-02-codebase` only

## Context

RAG-02 answers questions about code, and a chunk of code is only useful if it is a whole
declaration. The platform's chunkers are for prose: the structure-aware one parses Markdown headings
and paragraphs, and on a TypeScript file every block falls through to the line splitter, so a chunk
boundary lands wherever the token budget runs out — often between a function's signature and its
body. A citation into that chunk points at half a definition.

The exhibit therefore needs to know where each declaration starts and ends, including its doc
comment, and which names each declaration calls.

## Decision

`exhibits/rag-02-codebase` depends on `typescript` and uses the compiler's parser
(`ts.createSourceFile`) to find top-level declarations and call expressions. The dependency is
declared in the exhibit's own `package.json` and nowhere else; no package gains it.

The chunker built on it is supplied through `ingest`'s existing `ChunkStrategy` interface. No package
changed to accommodate it.

## Why a parser rather than patterns

A regular expression for "function declaration" gets the easy cases and silently misses the rest —
overloads, a declaration split across lines, a brace inside a template literal. Each miss becomes a
chunk that spans two declarations, and a wrong boundary produces a citation that looks precise and
is not. The compiler's parser is the one component guaranteed to agree with the compiler about where
a declaration begins.

## Consequences

**What it buys.** Exact declaration boundaries, doc comments attached to the declaration they
describe, and syntactic call edges, all from a parser the rest of the ecosystem already trusts.

**What it costs.**

_A heavy dependency for a leaf._ `typescript` is large. It is already in the workspace — a root
development dependency and a runtime dependency of `tools/boundaries` — so it adds no new supply-chain
exposure to the repository, but it does make the exhibit's install larger than its logic warrants.

_TypeScript only._ The exhibit indexes `.ts` files. A codebase in another language would need another
parser, and the strategy interface is where it would plug in.

_Call edges are syntactic, not resolved._ Without a type checker over the whole program, a call is
recorded by name and matched against the names the exhibit has seen. An unresolved name produces no
edge. The graph can therefore miss an edge; it cannot invent one.

_The compiler attaches a file's header comment to the first declaration._ Found on the exhibit's
first run, where an interface was cited from line 1. The exhibit treats a doc comment separated from
its declaration by a blank line as belonging to something else, which matches how people write
them and has a test.

**What it does not decide.** Nothing here changes a package. If a second exhibit needs a code
chunker, PRD 11.2's answer applies: promote it into a package deliberately, with its own ADR, rather
than importing it from this exhibit — which the boundary checker now catches by package name as well
as by path (P16).
