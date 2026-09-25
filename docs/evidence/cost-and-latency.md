# Cost and latency report

PRD 12 item 4. Produced by `pnpm loadrun`, from the reference profile PRD 9.1 requires.

## Reference profile

- **Profile:** local-openai-c4
- **Corpus snapshot:** sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9
- **Workload:** sha256:e32b75e87ef455fb27c16c47517cd3e02400c44c4d85a24dc4b6c590fcb23c34
- **Concurrency:** 4 (sustained, worker pool — not a burst)
- **Hardware:** 12 x 12th Gen Intel(R) Core(TM) i5-1245U, 16 GB, win32/x64, single process
- **Models:** embedder=text-embedding-3-small, generator=gpt-4.1-mini, reranker=none (bypassed by the served configuration, ADR 0011)
- **Price table:** openai-2026-09-24
- **Commit:** d1b5c50
- **Run:** 2026-09-25T15:00:38.834Z → 2026-09-25T15:02:23.964Z
- **Requests:** 260 (42 abstained)

## What this run measured, and what it did not

**No request left this machine.** No provider adapter is wired into these processes, so the
embedder, reranker and generator are the in-repo stand-ins named above. The permission,
retrieval and verification stages below are the code that ships and their timings are real.
The generation stage is a local function call, so the end-to-end figure omits the largest
component a deployed system would have — it is a floor, not an estimate.

**247 of 260 requests were served from the retrieval cache** (95%), because the
workload repeats and a repeated query for the same principal is the case the cache exists for.
That makes the combined end-to-end figure mostly a measurement of a cache lookup, so the table
below reports the cache-miss and cache-hit populations separately. They are different pieces of
work and averaging them produces a number that describes neither.

PRD 9.2 asks for hit rate **by cache**, and this run can answer for one of the two. The
embedding cache's hits happen inside retrieval and are reported to it rather than to this
harness, so its rate is absent rather than guessed.

## Budgets (PRD 9.3)

| Budget | Target | This run | Samples | Method |
| ------ | ------ | -------- | ------- | ------ |
| ANSWER-LATENCY-P95 | 3000 ms | 4633.711 ms (**over**) | 260 | scripted load run, fixed workload, stated concurrency |
| TIME-TO-FIRST-TOKEN-P95 | 1200 ms | **not measured** | — | streaming instrumentation on the same run |
| RETRIEVAL-STAGE-P95 | 400 ms | 247.3931 ms (within) | 13 | span aggregation |
| RERANK-STAGE-P95 | 500 ms | **not measured** | — | span aggregation at fixed candidate depth |
| PERMISSION-P95 | 50 ms | 0.0272 ms (within) | 260 | span aggregation |
| VERIFICATION-P95 | 100 ms | 0.0392 ms (within) | 260 | span aggregation |
| COST-PER-ANSWER-P50 | 0.02 usd | 0.0008 usd (within) | 218 | per-request token accounting x versioned price table |
| COST-PER-ANSWER-P95 | 0.06 usd | 0.0021 usd (within) | 218 | per-request token accounting x versioned price table |
| INGESTION-COST-PER-1K-CHUNKS | 0.5 usd | 0.001 usd (within) | 1 | embedding token accounting over the fixture |
| RETRIEVAL-ONLY-COST | 0.001 usd | 0 usd (within) | 260 | embedding token accounting over the fixture |

8 of 10 budgets were measured. A budget that was exceeded is reported with the stage breakdown below and **is not raised to make the build
pass** (PRD 9.3).

### What these figures do not say about themselves

- **ANSWER-LATENCY-P95** — 247 of 260 requests were served from the retrieval cache, so this figure is mostly the cost of a cache lookup rather than of an answer. The cache-miss row in the latency table is the one to read for the answer path.
- **INGESTION-COST-PER-1K-CHUNKS** — one ingestion of 35 chunks (1750 embedding tokens), priced at the table in force

### Why the rest could not be measured

Listed rather than omitted: a report that dropped the rows it could not fill would read as a
clean sheet.

- **TIME-TO-FIRST-TOKEN-P95** — no streaming instrumentation exists. The OpenAI adapter speaks the non-streaming endpoint (ADR 0006), and a first-token time cannot be inferred from a whole-response latency
- **RERANK-STAGE-P95** — the served configuration bypasses reranking (ADR 0011), so no request has a rerank stage to measure

## Latency by stage

Self time per request, summed across the spans a request produced for that stage — so each
request contributes one sample and a request with three spans cannot outvote one with a single
span.

| Stage | p50 (ms) | p95 (ms) | Samples |
| ----- | -------- | -------- | ------- |
| end-to-end | 1356.14 | 4633.71 | 260 |
| end-to-end (retrieval cache miss) | 1659.89 | 4950.88 † | 13 |
| end-to-end (retrieval cache hit) | 1348.2 | 4633.71 | 247 |
| audit-write | 0.03 | 0.07 | 260 |
| dense-retrieval | 193.51 | 246.92 † | 13 |
| fusion | 0.02 | 7.07 † | 13 |
| generation | 1348.7 | 4633.5 | 260 |
| lexical-retrieval | 0.26 | 0.46 † | 13 |
| permission-compile | 0.01 | 0.01 | 260 |
| permission-resolution | 0 | 0.01 | 260 |
| prompt-assembly | 0.02 | 0.04 | 260 |
| query-normalisation | 0.03 | 0.08 | 260 |
| verification | 0.01 | 0.04 | 260 |

† The p95 rests on twenty samples or fewer, where nearest-rank returns the maximum. It is the
largest value observed wearing a percentile's name, and a larger run would be needed before it
means anything else.

## Cost

Ingestion wrote 35 chunks in this run, and the token counts for every
model call were recorded. **No cost figure is produced**, because the price table in force
prices no stand-in (ADR 0002). The ratio of ingestion to serving cost that PRD 9.2 asks for is
unavailable for the same reason: both halves are token counts and neither has a price.

## What this artefact does not support

It does not support any claim about the latency or cost of a deployed system. It measures a
pipeline whose model calls are local, on one machine, at one concurrency, over a synthetic
corpus. PRD 12 item 4 requires this report **against a run with real models**, and until such
a run exists that item remains unmet — see `docs/promotion-readiness.md`.
