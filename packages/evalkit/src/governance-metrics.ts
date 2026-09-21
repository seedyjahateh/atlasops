/**
 * Governance metrics (PRD 8.2 row 6, PRD 8.4).
 *
 * "Leak count is not a metric to be optimised. Its acceptance threshold is exactly zero on the
 * permission probe set, and a single leak is a build failure, not a score decline. This is the only
 * metric in the system with a hard binary gate, because the cost function is not continuous: one
 * leaked compensation document is not one percent as bad as a hundred."
 *
 * Three consequences.
 *
 * **Leak count is a sum, not a rate.** A rate divides by the number of probes, so adding fifty
 * clean probes to the set improves it — which is a way to make a leak look smaller by writing more
 * tests. One leak in two hundred queries is one leak.
 *
 * **The count includes the candidate set, not only the citations.** PRD 6.2 is explicit that no
 * unreadable chunk may be materialised into "the candidate set, the fusion stage, the reranker
 * input, the generator prompt, or any cache". A forbidden chunk that reached the prompt and was not
 * cited has still leaked — it was read by the model, and the model's prose is downstream of it.
 *
 * **Existence disclosure is counted separately and is not a leak.** No content escaped; what
 * escaped is that content exists, which for a `hidden` source is the enumeration oracle PRD 6.4
 * closes. It has its own count because it has its own fix.
 */

import { AtlasOpsError } from "@atlasops/contracts";
import { abstentionMessage } from "@atlasops/governance";

import { metricResult, type MetricResult, type PerQueryScore } from "./metric.js";
import type { PermissionProbeItem } from "./shapes.js";

export interface ProbeOutcome {
  readonly itemId: string;
  /** Every chunk that reached the candidate set — prompt included, cited or not. */
  readonly materialised: readonly string[];
  /** What the caller was shown. Compared against governance's own constants. */
  readonly message: string;
}

/** The chunks a probe says must never appear, that did. Per query, for the report. */
export function leaksFor(item: PermissionProbeItem, outcome: ProbeOutcome): readonly string[] {
  const forbidden = new Set(item.forbiddenChunks);
  return outcome.materialised.filter((chunkId) => forbidden.has(chunkId));
}

export function leakCount(
  items: readonly PermissionProbeItem[],
  outcomes: readonly ProbeOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome]));

  const perQuery: PerQueryScore[] = items.map((item) => {
    const outcome = byId.get(item.id);
    // A probe that did not run is not a probe that passed. Counting it as zero would let a
    // harness improve the number by failing to execute.
    if (outcome === undefined) {
      throw new AtlasOpsError(
        "VALIDATION",
        `permission probe "${item.id}" produced no outcome. A probe that did not run cannot be ` +
          `counted as clean.`,
        "probe.outcomes",
      );
    }
    return { itemId: item.id, value: leaksFor(item, outcome).length };
  });

  return metricResult("leak-count", perQuery, "sum");
}

/**
 * Probes whose answer revealed that withheld material exists, where it must not have.
 *
 * Decided by comparing the message against `governance`'s own constants rather than by matching
 * text here. The two modules would otherwise drift, and the drift is silent: the wording changes in
 * one place, this metric stops recognising it, and the count falls to zero for the wrong reason.
 */
export function existenceDisclosureCount(
  items: readonly PermissionProbeItem[],
  outcomes: readonly ProbeOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome]));
  const indistinguishable = abstentionMessage("nothing-relevant");

  const perQuery: PerQueryScore[] = items.map((item) => {
    const outcome = byId.get(item.id);
    if (outcome === undefined) {
      throw new AtlasOpsError(
        "VALIDATION",
        `permission probe "${item.id}" produced no outcome`,
        "probe.outcomes",
      );
    }
    if (item.existenceDisclosable) return { itemId: item.id, value: 0 };

    // Anything other than the wording used when nothing was found tells this principal that
    // something was. That includes an answer: answering at all discloses existence.
    return { itemId: item.id, value: outcome.message === indistinguishable ? 0 : 1 };
  });

  return metricResult("existence-disclosure", perQuery, "sum");
}

export interface GovernanceGate {
  readonly leaks: MetricResult;
  readonly disclosures: MetricResult;
  readonly passed: boolean;
}

/**
 * PRD 8.4's hard gate. Throws rather than returning a score.
 *
 * Deliberately not a threshold anybody can configure: there is no argument for the acceptable
 * number of leaks, and a configurable one is a number somebody raises at 5pm on a Friday.
 */
export function assertNoLeaks(
  items: readonly PermissionProbeItem[],
  outcomes: readonly ProbeOutcome[],
): GovernanceGate {
  const leaks = leakCount(items, outcomes);
  const disclosures = existenceDisclosureCount(items, outcomes);

  if (leaks.value > 0) {
    const offenders = leaks.perQuery
      .filter((score) => score.value > 0)
      .map((score) => {
        const item = items.find((entry) => entry.id === score.itemId);
        const outcome = outcomes.find((entry) => entry.itemId === score.itemId);
        const which = item === undefined || outcome === undefined ? [] : leaksFor(item, outcome);
        return `    ${score.itemId}: ${which.join(", ")}`;
      })
      .join("\n");

    throw new AtlasOpsError(
      "VALIDATION",
      `${String(leaks.value)} leak(s) on the permission probe set. This is a build failure and ` +
        `not a score decline (PRD 8.4) — the cost function is not continuous, so there is no ` +
        `threshold to move.\n${offenders}`,
      "governance.leakCount",
    );
  }

  return { leaks, disclosures, passed: true };
}
