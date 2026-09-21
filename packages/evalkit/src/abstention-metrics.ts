/**
 * Abstention metrics (PRD 8.2, row 5; PRD 7.3).
 *
 * "A system that never abstains is not more useful, it is less honest, and the labelled
 * unanswerable subset is what keeps that from being a matter of opinion."
 *
 * Two rates, deliberately not one. A single "abstention accuracy" would let a system that refuses
 * everything and one that answers everything land on the same number for different reasons, and the
 * two failures need different fixes — the first is a threshold set too high, the second is a
 * retrieval or verification problem being hidden by an eager generator.
 *
 * Both are reported as rates over their own subsets, so neither is diluted by the other's items.
 * The denominators are therefore different, and a report that quotes one without its sample size is
 * quoting a number over an unknown number of queries.
 */

import { AtlasOpsError } from "@atlasops/contracts";

import { metricResult, type MetricResult, type PerQueryScore } from "./metric.js";
import type { AbstentionItem } from "./shapes.js";

export interface AbstentionOutcome {
  readonly itemId: string;
  readonly abstained: boolean;
}

function split(
  items: readonly AbstentionItem[],
  outcomes: readonly AbstentionOutcome[],
  wanted: boolean,
): PerQueryScore[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.abstained]));

  return items
    .filter((item) => item.shouldAbstain === wanted)
    .flatMap((item) => {
      const abstained = byId.get(item.id);
      if (abstained === undefined) return [];
      return [{ itemId: item.id, value: abstained === wanted ? 1 : 0 }];
    });
}

/** Of the queries where refusal is correct, the share the system refused. Higher is better. */
export function correctAbstentionRate(
  items: readonly AbstentionItem[],
  outcomes: readonly AbstentionOutcome[],
): MetricResult {
  const perQuery = split(items, outcomes, true);
  if (perQuery.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "the abstention set contains no query where refusal is correct, so a correct-abstention " +
        "rate over it would be vacuous",
      "dataset.items",
    );
  }
  return metricResult("correct-abstention", perQuery);
}

/**
 * Of the queries that are answerable, the share the system refused anyway. Lower is better.
 *
 * Scored so that 1 means "refused an answerable query", which is the failure, rather than
 * following `correctAbstentionRate`'s convention where 1 is good. Two rates that both read
 * "higher is better" would be easier to skim and would hide that they pull in opposite directions.
 */
export function overAbstentionRate(
  items: readonly AbstentionItem[],
  outcomes: readonly AbstentionOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.abstained]));

  const perQuery: PerQueryScore[] = items
    .filter((item) => !item.shouldAbstain)
    .flatMap((item) => {
      const abstained = byId.get(item.id);
      if (abstained === undefined) return [];
      return [{ itemId: item.id, value: abstained ? 1 : 0 }];
    });

  if (perQuery.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "the abstention set contains no answerable query, so an over-abstention rate over it would " +
        "be vacuous — and a set of only unanswerable queries rewards a system that never answers",
      "dataset.items",
    );
  }

  return metricResult("over-abstention", perQuery);
}
