# Ablation deltas

Corpus snapshot: sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9

| Metric | Arm | Against | Δ | CI lower | CI upper | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| recall@10 | dense-only | fused-with-rerank | 0.1548 | 0.0119 | 0.2976 | improvement |
| nDCG@10 | dense-only | fused-with-rerank | 0.2230 | 0.1159 | 0.3356 | improvement |
| MRR | dense-only | fused-with-rerank | 0.2850 | 0.1303 | 0.4476 | improvement |
| contribution:dense | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| citation-precision | dense-only | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| citation-recall | dense-only | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| span-validity | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | dense-only | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| contradiction-rate | dense-only | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| judge-human-agreement | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| over-abstention | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | dense-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | dense-only | fused-with-rerank | 0.0000 | -0.0001 | 0.0001 | no-change |
| recall@10 | lexical-only | fused-with-rerank | -0.1190 | -0.2262 | -0.0238 | regression |
| nDCG@10 | lexical-only | fused-with-rerank | 0.0598 | -0.1612 | 0.2537 | no-change |
| MRR | lexical-only | fused-with-rerank | 0.1065 | -0.1595 | 0.3605 | no-change |
| contribution:lexical | lexical-only | fused-with-rerank | 0.0595 | 0.0000 | 0.1429 | no-change |
| citation-precision | lexical-only | fused-with-rerank | 0.0000 | -0.4286 | 0.4286 | no-change |
| citation-recall | lexical-only | fused-with-rerank | 0.0000 | -0.4286 | 0.4286 | no-change |
| span-validity | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | lexical-only | fused-with-rerank | 0.0000 | -0.4286 | 0.4286 | no-change |
| contradiction-rate | lexical-only | fused-with-rerank | 0.0000 | -0.4286 | 0.4286 | no-change |
| judge-human-agreement | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | lexical-only | fused-with-rerank | -0.4000 | -0.8000 | 0.0000 | no-change |
| over-abstention | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | lexical-only | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | lexical-only | fused-with-rerank | 0.0003 | 0.0002 | 0.0004 | improvement |
| recall@10 | fused-no-rerank | fused-with-rerank | 0.1310 | -0.0119 | 0.2857 | no-change |
| nDCG@10 | fused-no-rerank | fused-with-rerank | 0.1476 | -0.0289 | 0.3146 | no-change |
| MRR | fused-no-rerank | fused-with-rerank | 0.1743 | -0.0745 | 0.4046 | no-change |
| contribution:dense | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| contribution:lexical | fused-no-rerank | fused-with-rerank | -0.0476 | -0.1548 | 0.0476 | no-change |
| citation-precision | fused-no-rerank | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| citation-recall | fused-no-rerank | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| span-validity | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| supported-claim-rate | fused-no-rerank | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| contradiction-rate | fused-no-rerank | fused-with-rerank | 0.1429 | 0.0000 | 0.4286 | no-change |
| judge-human-agreement | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| correct-abstention | fused-no-rerank | fused-with-rerank | -0.2000 | -0.6000 | 0.0000 | no-change |
| over-abstention | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| leak-count | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| existence-disclosure | fused-no-rerank | fused-with-rerank | 0.0000 | 0.0000 | 0.0000 | no-change |
| cost-per-answer | fused-no-rerank | fused-with-rerank | -0.0000 | -0.0001 | 0.0001 | no-change |

An ablation is not a regression: these deltas say what each arm contributes, and a negative
one is the expected shape of removing a retriever rather than a build failure.
