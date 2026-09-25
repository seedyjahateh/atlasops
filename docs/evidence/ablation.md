# Ablation deltas

Corpus snapshot: sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9

| Metric | Arm | Against | Δ | CI lower | CI upper | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| recall@10 | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| nDCG@10 | dense-only | fused-no-rerank | 0.0829 | 0.0073 | 0.2006 | improvement |
| MRR | dense-only | fused-no-rerank | 0.1409 | 0.0000 | 0.3500 | no-change |
| contribution:dense | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| citation-precision | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| citation-recall | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| span-validity | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| contradiction-rate | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| judge-human-agreement | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | dense-only | fused-no-rerank | 0.2500 | 0.0000 | 0.7500 | no-change |
| over-abstention | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | dense-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | dense-only | fused-no-rerank | 0.0001 | 0.0000 | 0.0001 | improvement |
| recall@10 | lexical-only | fused-no-rerank | -0.3182 | -0.5455 | -0.0909 | regression |
| nDCG@10 | lexical-only | fused-no-rerank | -0.0897 | -0.1969 | -0.0094 | regression |
| MRR | lexical-only | fused-no-rerank | -0.0409 | -0.1000 | 0.0000 | no-change |
| contribution:lexical | lexical-only | fused-no-rerank | 0.1364 | 0.0000 | 0.2727 | no-change |
| citation-precision | lexical-only | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| citation-recall | lexical-only | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| span-validity | lexical-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | lexical-only | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| contradiction-rate | lexical-only | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| judge-human-agreement | lexical-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | lexical-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| over-abstention | lexical-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | lexical-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | lexical-only | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | lexical-only | fused-no-rerank | 0.0003 | 0.0002 | 0.0004 | improvement |
| recall@10 | fused-with-rerank | fused-no-rerank | -0.1667 | -0.3485 | 0.0152 | no-change |
| nDCG@10 | fused-with-rerank | fused-no-rerank | -0.1518 | -0.3054 | 0.0231 | no-change |
| MRR | fused-with-rerank | fused-no-rerank | -0.1439 | -0.3682 | 0.1091 | no-change |
| contribution:dense | fused-with-rerank | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| contribution:lexical | fused-with-rerank | fused-no-rerank | 0.0606 | -0.0606 | 0.1970 | no-change |
| citation-precision | fused-with-rerank | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| citation-recall | fused-with-rerank | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| span-validity | fused-with-rerank | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | fused-with-rerank | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| contradiction-rate | fused-with-rerank | fused-no-rerank | -0.1667 | -0.5000 | 0.0000 | no-change |
| judge-human-agreement | fused-with-rerank | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | fused-with-rerank | fused-no-rerank | 0.2500 | 0.0000 | 0.7500 | no-change |
| over-abstention | fused-with-rerank | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | fused-with-rerank | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | fused-with-rerank | fused-no-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | fused-with-rerank | fused-no-rerank | -0.0000 | -0.0002 | 0.0001 | no-change |

An ablation is not a regression: these deltas say what each arm contributes, and a negative
one is the expected shape of removing a retriever rather than a build failure.
