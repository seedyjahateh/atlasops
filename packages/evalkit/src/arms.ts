/**
 * The ablation arms (PRD 8.2).
 *
 * "Ablation is not optional. The claim 'hybrid retrieval and reranking improve results' is only a
 * claim this project is entitled to make if the harness can run dense-only, lexical-only,
 * fused-without-rerank, and fused-with-rerank arms over the same dataset version and report the
 * deltas. Without ablation, the architecture in section 5 is an assertion."
 *
 * The four arms are named here rather than left to a caller to assemble, so that "the same four
 * arms" means the same four arms in every run and in every artefact. `configForArm` builds each
 * from one base configuration through `retrieval`'s own `ablate`, which validates — so an arm that
 * disabled both retrievers would fail to construct rather than quietly producing a row of zeroes.
 *
 * The arms differ only in the switches. Everything else — `k`, the depths, the limit, the temporal
 * scope, the provenance — comes from the base config unchanged, because an ablation in which two
 * arms also differ in their depth is not an ablation of the arm.
 */

import { ablate, type RetrievalConfig } from "@atlasops/retrieval";

export const ARMS = ["dense-only", "lexical-only", "fused-no-rerank", "fused-with-rerank"] as const;

export type ArmName = (typeof ARMS)[number];

export function configForArm(base: RetrievalConfig, arm: ArmName): RetrievalConfig {
  switch (arm) {
    case "dense-only":
      return ablate(base, {
        lexical: { enabled: false, depth: base.lexical.depth },
        rerank: { enabled: false, depth: base.rerank.depth },
      });
    case "lexical-only":
      return ablate(base, {
        dense: { enabled: false, depth: base.dense.depth },
        rerank: { enabled: false, depth: base.rerank.depth },
      });
    case "fused-no-rerank":
      return ablate(base, {
        dense: { enabled: true, depth: base.dense.depth },
        lexical: { enabled: true, depth: base.lexical.depth },
        rerank: { enabled: false, depth: base.rerank.depth },
      });
    case "fused-with-rerank":
      return ablate(base, {
        dense: { enabled: true, depth: base.dense.depth },
        lexical: { enabled: true, depth: base.lexical.depth },
        rerank: { enabled: true, depth: base.rerank.depth },
      });
  }
}
