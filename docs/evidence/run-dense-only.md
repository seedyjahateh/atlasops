# Evaluation run sha256:b49136b2e77781ae386aff6f7b58f68490a225cafb04123e2600270a538af13c

- **System:** atlasops
- **Arm:** dense-only
- **Commit:** d1b5c50
- **Measured at:** 2026-09-25T14:58:28.454Z
- **Judge:** stand-in-judge@v1

## Models

- **embedder:** `text-embedding-3-small`
- **generator:** `gpt-4.1-mini`
- **judge:** `stand-in-judge`
- **reranker:** `stand-in-reranker (unselected: no provider rerank model, ADR 0006)`

Runs per arm: 1. PRD 8.5 asks for repeated runs with reported variance where a system cannot
be made deterministic; every model in this build is a deterministic stand-in, so repetition
would produce identical numbers and a variance of zero that means nothing.

## Datasets

- corpus-relevance@1.0.0 (sha256:46cb25bfd38ffec12202743caa40b7cdd0052da677053aeb9306c2edf08c9566, corpus sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9)
- corpus-grounded-answers@1.0.0 (sha256:c0f18a6eb423a9bf8fe23e3c4c806cf6e1d9357aa2217a5d69c1ceaba16abcc9, corpus sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9)
- corpus-abstention@1.0.0 (sha256:117f46fc1a0cbe7fd568c0b213f77da3c4f84c3fe23ca63f3cef79fb0f51af03, corpus sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9)
- corpus-permission-probe@1.0.0 (sha256:e91788e77d6f286064dd4c77eefe84cd601c9c5db1d0acd528e442f49e1e7e3a, corpus sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9)

Splits evaluated: development.

## Metrics

### Retrieval

| Metric | Value | Queries | Aggregation |
| --- | --- | --- | --- |
| recall@10 | 0.9242 | 11 | mean |
| nDCG@10 | 0.9493 | 11 | mean |
| MRR | 1 | 11 | mean |
| contribution:dense | 1 | 11 | mean |

### Fusion and rerank

_Not measured: this run is the "dense-only" arm; the deltas are a comparison across arms._

### Citation

| Metric | Value | Queries | Aggregation |
| --- | --- | --- | --- |
| citation-precision | 1 | 6 | mean |
| citation-recall | 1 | 6 | mean |
| span-validity | 1 | 6 | mean |

### Groundedness

| Metric | Value | Queries | Aggregation |
| --- | --- | --- | --- |
| supported-claim-rate | 1 | 6 | mean |
| contradiction-rate | 0 | 6 | mean |
| judge-human-agreement | 1 | 4 | mean |

### Abstention

| Metric | Value | Queries | Aggregation |
| --- | --- | --- | --- |
| correct-abstention | 1 | 4 | mean |
| over-abstention | 0 | 2 | mean |

### Governance

| Metric | Value | Queries | Aggregation |
| --- | --- | --- | --- |
| leak-count | 0 | 6 | sum |
| existence-disclosure | 0 | 6 | sum |

### Cost and latency

| Metric | Value | Queries | Aggregation |
| --- | --- | --- | --- |
| cost-per-answer | 0.0007 | 29 | mean |

## Latency

| Stage | p50 (ms) | p95 (ms) | Samples |
| --- | --- | --- | --- |
| end-to-end | 178.4 | 364.5 | 29 |

## Governance

Leak count **0** over 6 probes; existence disclosures **0**. The run reached this report, so the leak gate passed — PRD 8.4 makes a leak a build failure rather than a number printed here.

## Per-query results

29 records retained. PRD 8.5 requires them for the paired
comparison; they are the artefact's payload, not an appendix.
