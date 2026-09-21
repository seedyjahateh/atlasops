/**
 * Retrieval configuration and the ablation switches (PRD 5.2, 5.3).
 *
 * **Every number here is unselected, and the config says so.** PRD 5.2 is explicit that `k` and the
 * per-retriever depths "are to be selected on the labelled development split (section 8) and
 * recorded in the evaluation artefact — not chosen here and not asserted anywhere as tuned until
 * that selection has actually been run." So the defaults carry `provenance: "unselected-default"`,
 * every result records the provenance of the config that produced it, and P10's harness is what
 * flips it. A default that looked like a tuned value would be restated as one within a week.
 *
 * `k = 60` is the constant from the original RRF paper. It is a starting point somebody else
 * published, not a value measured here, and that is the whole of its claim.
 *
 * **Each arm can be ablated by configuration**, which PRD 5.3 requires so the evaluation harness
 * can measure what the reranker actually contributes, and PRD 5.1 requires so the contribution of
 * each retriever can be measured separately. Disabling *both* retrievers is refused rather than
 * returning nothing: an ablation that retrieves from nowhere produces a row of zeroes that reads
 * like a result.
 */

import { AtlasOpsError } from "@atlasops/contracts";

import { requireScope, type TemporalScope } from "./temporal.js";

export type ConfigProvenance =
  /** Conventional starting values. Not measured, and not quotable as tuned. */
  | "unselected-default"
  /** Selected on the labelled development split and recorded in an evaluation artefact. */
  | "selected-on-dev-split";

export interface ArmConfig {
  readonly enabled: boolean;
  /** How many candidates this stage takes. */
  readonly depth: number;
}

export interface RetrievalConfig {
  readonly dense: ArmConfig;
  readonly lexical: ArmConfig;
  /** RRF's one interpretable parameter. */
  readonly fusionK: number;
  readonly rerank: ArmConfig;
  /** How many candidates leave retrieval. */
  readonly limit: number;
  readonly temporal: TemporalScope;
  readonly provenance: ConfigProvenance;
}

export const RETRIEVAL_DEFAULTS: RetrievalConfig = {
  dense: { enabled: true, depth: 50 },
  lexical: { enabled: true, depth: 50 },
  fusionK: 60,
  rerank: { enabled: true, depth: 20 },
  limit: 8,
  temporal: { kind: "current" },
  provenance: "unselected-default",
};

function requireDepth(value: number, path: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${path} must be a positive integer, received ${String(value)}`,
      path,
    );
  }
}

export function validateConfig(config: RetrievalConfig): RetrievalConfig {
  if (!config.dense.enabled && !config.lexical.enabled) {
    throw new AtlasOpsError(
      "VALIDATION",
      "both retrieval arms are disabled. An ablation that retrieves from nowhere does not measure " +
        "the contribution of a retriever, it produces a row of zeroes that reads like a result.",
      "config",
    );
  }

  if (config.dense.enabled) requireDepth(config.dense.depth, "config.dense.depth");
  if (config.lexical.enabled) requireDepth(config.lexical.depth, "config.lexical.depth");
  if (config.rerank.enabled) requireDepth(config.rerank.depth, "config.rerank.depth");
  requireDepth(config.limit, "config.limit");

  if (!Number.isFinite(config.fusionK) || config.fusionK <= 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `config.fusionK must be positive, received ${String(config.fusionK)}`,
      "config.fusionK",
    );
  }

  requireScope(config.temporal);
  return config;
}

/** A config with one field changed, validated. The shape an ablation run produces. */
export function ablate(config: RetrievalConfig, change: Partial<RetrievalConfig>): RetrievalConfig {
  return validateConfig({ ...config, ...change });
}

/**
 * A stable identity for a configuration, for cache keys and for evaluation artefacts.
 *
 * It includes the provenance, so a result produced under unselected defaults can never be served
 * from a cache entry written under a selected config, or vice versa.
 */
export function configKey(config: RetrievalConfig): string {
  const arm = (name: string, value: ArmConfig): string =>
    `${name}:${value.enabled ? String(value.depth) : "off"}`;
  const temporal =
    config.temporal.kind === "current" ? "current" : `as-of:${config.temporal.instant}`;

  return [
    arm("dense", config.dense),
    arm("lexical", config.lexical),
    arm("rerank", config.rerank),
    `k:${String(config.fusionK)}`,
    `limit:${String(config.limit)}`,
    temporal,
    config.provenance,
  ].join("\u001f");
}
