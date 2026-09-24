# Ablation deltas

Corpus snapshot: sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9

| Metric | Arm | Against | Δ | CI lower | CI upper | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| recall@10 | dense-only | fused-with-rerank | 0.1667 | -0.0152 | 0.3485 | no-change |
| nDCG@10 | dense-only | fused-with-rerank | 0.2348 | 0.1109 | 0.3660 | improvement |
| MRR | dense-only | fused-with-rerank | 0.2848 | 0.1061 | 0.4788 | improvement |
| contribution:dense | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| citation-precision | dense-only | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| citation-recall | dense-only | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| span-validity | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | dense-only | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| contradiction-rate | dense-only | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| judge-human-agreement | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| over-abstention | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | dense-only | fused-with-rerank | 0.0001 | -0.0000 | 0.0002 | no-change |
| recall@10 | lexical-only | fused-with-rerank | -0.1515 | -0.2879 | -0.0303 | regression |
| nDCG@10 | lexical-only | fused-with-rerank | 0.0621 | -0.1814 | 0.2484 | no-change |
| MRR | lexical-only | fused-with-rerank | 0.1030 | -0.2000 | 0.3606 | no-change |
| contribution:lexical | lexical-only | fused-with-rerank | 0.0758 | 0.0000 | 0.1818 | no-change |
| citation-precision | lexical-only | fused-with-rerank | 0.0000 | -0.5000 | 0.5000 | no-change |
| citation-recall | lexical-only | fused-with-rerank | 0.0000 | -0.5000 | 0.5000 | no-change |
| span-validity | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | lexical-only | fused-with-rerank | 0.0000 | -0.5000 | 0.5000 | no-change |
| contradiction-rate | lexical-only | fused-with-rerank | 0.0000 | -0.5000 | 0.5000 | no-change |
| judge-human-agreement | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | lexical-only | fused-with-rerank | -0.2500 | -0.7500 | 0.0000 | no-change |
| over-abstention | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | lexical-only | fused-with-rerank | 0.0003 | 0.0002 | 0.0004 | improvement |
| recall@10 | fused-no-rerank | fused-with-rerank | 0.1667 | -0.0152 | 0.3485 | no-change |
| nDCG@10 | fused-no-rerank | fused-with-rerank | 0.1518 | -0.0231 | 0.3054 | no-change |
| MRR | fused-no-rerank | fused-with-rerank | 0.1439 | -0.1091 | 0.3682 | no-change |
| contribution:dense | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| contribution:lexical | fused-no-rerank | fused-with-rerank | -0.0606 | -0.1970 | 0.0606 | no-change |
| citation-precision | fused-no-rerank | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| citation-recall | fused-no-rerank | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| span-validity | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | fused-no-rerank | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| contradiction-rate | fused-no-rerank | fused-with-rerank | 0.1667 | 0.0000 | 0.5000 | no-change |
| judge-human-agreement | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | fused-no-rerank | fused-with-rerank | -0.2500 | -0.7500 | 0.0000 | no-change |
| over-abstention | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | fused-no-rerank | fused-with-rerank | 0.0000 | -0.0001 | 0.0001 | no-change |

An ablation is not a regression: these deltas say what each arm contributes, and a negative
one is the expected shape of removing a retriever rather than a build failure.
