# Governance report

- **Commit:** d1b5c50
- **Arm:** fused-no-rerank
- **Measured at:** 2026-09-25T14:59:48.072Z

## Permission probe set

- **Dataset:** corpus-permission-probe@1.0.0 (sha256:e91788e77d6f286064dd4c77eefe84cd601c9c5db1d0acd528e442f49e1e7e3a, corpus sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9)
- **Probes declared:** 7
- **Probes in scope for this run:** 6 (splits: development)
- **Probes executed:** 6

## Leak count

**0**, summed over 6 probes.

A leak is a chunk the probe set says this principal must never see that reached the candidate
set — cited or not, because PRD 6.2 forbids materialising an unreadable chunk into the prompt
at all. The count is a sum rather than a rate: adding clean probes must not make a leak look
smaller.

The gate passed. PRD 8.4 makes a non-zero count a build failure rather than a caveat, so a run that leaked would not have produced this file.

## Prompt-injection subset

- **Injection probes:** 2
- **Leaks within the subset:** 0

The defence these probes exercise is not detection. A passage cannot close its own prompt
block, and an answer that cites a chunk the model was not shown fails verification — so an
injection that works still cannot produce a released answer. The unit tests in
`packages/grounding` exercise that directly against a corpus of injection passages; this
subset is the same property measured end to end.

## Existence disclosure

**0** over 6 probes.

Counted separately from leaks because no content escaped: what escaped is that content exists,
which for a `hidden` source is the enumeration oracle PRD 6.4 closes. It has its own count
because it has its own fix.

## Audit-record schema

Derived from a record this run actually wrote, rather than transcribed — a hand-written
field list is a second copy of the contract, and the second copy is the one that goes
stale.

- `citedChunks`
- `costUsd`
- `decisions`
- `groupSetHash`
- `inputTokens`
- `models`
- `outputTokens`
- `predicate`
- `principalId`
- `promptChunks`
- `queryHash`
- `requestId`
- `stageTimings`
- `writtenAt`

## What this artefact does and does not support

A leak count measures the permission pre-filter, which is ordinary code with no model in it,
so this number is a measurement of the system that ships rather than of a stand-in. That is
unusual in this build and is the reason this artefact is stated without qualification.

It supports no claim about retrieval quality, answer quality, cost or latency. Those depend on
models this repository does not install, and PRD 12's other required artefacts remain
outstanding — see `docs/promotion-readiness.md`.
