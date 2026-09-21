# ADR 0005 — A composition layer between the packages and the applications

- **Status:** accepted
- **Phase:** P11a (`packages/composition`)
- **Specification:** PRD 8, 10, 11.2

## Context

PRD 10 separates four runtime components because they have different scaling and failure
characteristics: an answer API, an ingestion worker, an evaluation runner, and a console. PRD 11.2
forbids an application importing another application, and it is right to: applications are wiring,
not libraries, and an `apps/api` that other applications imported would stop being a deployment
surface and start being a package with a confusing name.

That leaves `apps/eval-runner` with a problem the other three do not have. Its job is to measure the
answer pipeline. If it cannot import `apps/api`, it has to assemble the pipeline itself — the same
retrieval configuration, the same fusion constant, the same support policy, the same prompt
assembly, wired the same way. Two assemblies of the same parts drift, and the first thing that
drifts is a default nobody thought was load-bearing.

The failure that produces is specific and bad. An evaluation run passes every gate in PRD 8 while
the API serves a pipeline that differs in one parameter, and every number in the evidence artefact
is a measurement of something that is not in production. PRD 8 exists to make claims about the
system defensible; an evaluation of a nearly-identical system defends nothing, and does it
convincingly.

PRD 11.2 already names the remedy for exactly this shape: "When two exhibits genuinely need the same
helper, the answer is to promote it into a package with a defined contract — a deliberate, reviewed
act — rather than to import sideways."

## Decision

**`packages/composition` is added as a new layer, `composition`, between `evaluation` and
`runtime`.** The application group moves from layer 8 to layer 9.

It owns the assembly and nothing else: given ports — indexes, an embedding gateway, a reranker, a
generator, a corpus store, an audit sink, a chunk sink, clocks — it returns an answer pipeline and
an ingestion pipeline. It holds no transport, no configuration parsing, no process lifecycle and no
I/O of its own. Those remain the applications' job, which is what keeps this from becoming the
"shared utils" package that swallows a codebase.

The layer sits above `evalkit` because the answer pipeline it builds satisfies `evalkit`'s
`AnswerSystem` port, so `composition` is what makes the evaluated object and the served object the
same object rather than two descriptions of one.

## Consequences

`apps/api` and `apps/eval-runner` construct the same pipeline by construction rather than by
review. That is the whole point, and it is the only reason this layer exists.

The cost is one more layer, and layers are not free — each one is a boundary somebody has to
understand before they can put code in the right place. It is also a package that can accumulate:
"the composition root" is an inviting home for anything that two applications happen to share, and
the first helper that lands here for convenience rather than necessity starts the decay PRD 11.2
warns about. The mitigation is the `owns` line in `layers.json`, which says assembly and not
utilities, and the fact that its dependency row lists every package below it — so a reviewer can see
at a glance that it is allowed to touch everything, and should therefore contain as little as
possible.

The alternative considered and rejected: let `apps/eval-runner` talk to `apps/api` over HTTP, as it
would in a deployed system. That is a fine production topology and a bad test topology — it makes
every evaluation run require a server, a port, and a readiness wait, and it moves the failure mode
from "drift between two assemblies" to "the evaluation silently measured a stale deployment". The
in-process composition does not preclude the HTTP arrangement later; an `AnswerSystem` that issues
HTTP requests is a different implementation of the same port.
