# Retrieval by split

- **Commit:** 9be9fd5
- **Corpus snapshot:** sha256:f05a2049d6de1bb249071782efe6e5d32e092a7fb39bf65e66af376b5179b8b9

The run's reports pool every split it evaluated. This breaks retrieval out by split, from the
same per-query records and the same metric definitions, so that a held-out result can be read
on its own. Per-query nDCG@10 is listed because over a handful of items a mean hides which
item moved it. No confidence interval is drawn: a bootstrap over a few pairs looks precise and
is not.

## development (11 relevance items)

| Arm | recall@10 | nDCG@10 | MRR | nDCG@10 per query |
| --- | --- | --- | --- | --- |
| dense-only | 0.9242 | 0.9493 | 1.0000 | rel-001 0.9828, rel-002 1.0000, rel-003 0.9750, rel-004 0.9468, rel-005 0.6783, rel-006 0.9680, rel-007 0.9738, rel-008 1.0000, rel-009 1.0000, rel-010 0.9173, rel-011 1.0000 |
| lexical-only | 0.6061 | 0.7766 | 0.8182 | rel-001 0.9173, rel-002 1.0000, rel-003 0.9686, rel-004 0.9049, rel-005 0.0000, rel-006 0.0000, rel-007 0.9173, rel-008 1.0000, rel-009 0.9173, rel-010 0.9173, rel-011 1.0000 |
| fused-no-rerank | 0.9242 | 0.8663 | 0.8591 | rel-001 0.9640, rel-002 1.0000, rel-003 0.9686, rel-004 0.9049, rel-005 0.4385, rel-006 0.3985, rel-007 0.9738, rel-008 1.0000, rel-009 0.9640, rel-010 0.9173, rel-011 1.0000 |
| fused-with-rerank | 0.7576 | 0.7145 | 0.7152 | rel-001 0.9640, rel-002 1.0000, rel-003 0.8174, rel-004 0.5341, rel-005 0.0412, rel-006 0.9173, rel-007 0.9173, rel-008 0.6309, rel-009 0.4587, rel-010 0.5788, rel-011 1.0000 |

## held-out (3 relevance items)

| Arm | recall@10 | nDCG@10 | MRR | nDCG@10 per query |
| --- | --- | --- | --- | --- |
| dense-only | 1.0000 | 0.8221 | 0.8333 | rel-012 0.8354, rel-013 0.6309, rel-014 1.0000 |
| lexical-only | 0.8889 | 0.6936 | 0.6667 | rel-012 0.4499, rel-013 1.0000, rel-014 0.6309 |
| fused-no-rerank | 0.8889 | 0.7743 | 0.8333 | rel-012 0.6920, rel-013 1.0000, rel-014 0.6309 |
| fused-with-rerank | 0.8889 | 0.6424 | 0.5476 | rel-012 0.5938, rel-013 0.3333, rel-014 1.0000 |
