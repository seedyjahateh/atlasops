/**
 * The closed set of stages (PRD 9.2).
 *
 * Closed rather than free-form, because the budgets in PRD 9.3 are expressed per stage — "retrieval
 * stage (both arms + fusion), p95 ≤400 ms" only means something if "retrieval" names the same
 * spans every run. A free-form string here would let two spellings of `rerank` split one budget
 * into two half-populated ones, and the aggregate would look fine.
 */

export const STAGES = [
  "query-normalisation",
  "permission-resolution",
  "permission-compile",
  "dense-retrieval",
  "lexical-retrieval",
  "fusion",
  "reranking",
  "prompt-assembly",
  "generation",
  "verification",
  "audit-write",
  /**
   * Not in PRD 9.2's request list, which describes a query trace. It is here because PRD 9.3
   * budgets ingestion cost per 1,000 chunks by "embedding token accounting over the fixture", and
   * that accounting needs a stage to attribute its model calls to.
   */
  "embedding",
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Stage groups, so a budget can name a phase that spans several stages.
 *
 * PRD 9.3's retrieval budget covers "both arms + fusion". Encoding that here means the budget and
 * the aggregation agree by construction rather than because two people read the table the same way.
 */
export const STAGE_GROUPS = {
  retrieval: ["dense-retrieval", "lexical-retrieval", "fusion"],
  permissions: ["permission-resolution", "permission-compile"],
} as const satisfies Record<string, readonly Stage[]>;

export type StageGroup = keyof typeof STAGE_GROUPS;

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}
