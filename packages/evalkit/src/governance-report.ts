/**
 * The governance report (PRD 12 item 3).
 *
 * "The permission probe set version, the number of probes, the leak count, the prompt-injection
 * subset result, and the audit-record schema. The leak count must be zero; a non-zero count blocks
 * the promotion outright rather than being reported as a caveat."
 *
 * This is the one required artefact in PRD 12 that this build can produce **without qualification**,
 * and the reason is worth stating in the report itself: a leak count measures the permission
 * pre-filter, which is ordinary code with no model in it. Every other number the system produces
 * is a measurement of a stand-in. This one is a measurement of the thing that ships.
 *
 * **The audit schema is derived from a real record rather than described.** A hand-written field
 * list is a second copy of the contract, and the second copy is the one that goes stale — a report
 * claiming the audit holds a field it stopped holding is worse than no report.
 *
 * The probe outcomes are reconstructed from the run's per-query records rather than passed in
 * beside them. Those records are what PRD 8.5 already requires to be retained, so the report and
 * the run cannot disagree about what happened.
 */

import type { AuditRecord } from "@atlasops/governance";

import type { Dataset } from "./dataset.js";
import { datasetRef } from "./dataset.js";
import {
  existenceDisclosureCount,
  leakCount,
  leaksFor,
  type ProbeOutcome,
} from "./governance-metrics.js";
import type { RunReport } from "./harness.js";
import type { PermissionProbeItem } from "./shapes.js";

export const INJECTION_SUBPOPULATION = "prompt-injection";

export interface GovernanceReportInput {
  readonly run: RunReport;
  readonly probes: Dataset<PermissionProbeItem>;
  /** One real record from the run. Null only when the run produced none. */
  readonly auditSample: AuditRecord | null;
  readonly commit: string | null;
}

/** The probe outcomes this run produced, taken from the records PRD 8.5 already retains. */
export function probeOutcomesOf(
  run: RunReport,
  probes: Dataset<PermissionProbeItem>,
): readonly ProbeOutcome[] {
  const wanted = new Set(probes.items.map((item) => item.id));
  return run.perQuery
    .filter((record) => wanted.has(record.itemId))
    .map((record) => ({
      itemId: record.itemId,
      materialised: record.candidateChunks,
      message: record.message,
    }));
}

function schemaOf(record: AuditRecord | null): readonly string[] {
  if (record === null) return [];
  return Object.keys(record).sort();
}

export function renderGovernanceReport(input: GovernanceReportInput): string {
  const { run, probes } = input;
  const outcomes = probeOutcomesOf(run, probes);
  const leaks = leakCount(probes.items, outcomes);
  const disclosures = existenceDisclosureCount(probes.items, outcomes);

  const injection = probes.items.filter((item) => item.subpopulation === INJECTION_SUBPOPULATION);
  const injectionOutcomes = outcomes.filter((outcome) =>
    injection.some((item) => item.id === outcome.itemId),
  );
  const injectionLeaks = injection.flatMap((item) => {
    const outcome = injectionOutcomes.find((entry) => entry.itemId === item.id);
    return outcome === undefined ? [] : leaksFor(item, outcome);
  });

  const schema = schemaOf(input.auditSample);

  const lines = [
    "# Governance report",
    "",
    `- **Commit:** ${input.commit ?? "not recorded"}`,
    `- **Arm:** ${run.arm}`,
    `- **Measured at:** ${run.measuredAt}`,
    "",
    "## Permission probe set",
    "",
    `- **Dataset:** ${datasetRef(probes)}`,
    `- **Probes:** ${String(probes.items.length)}`,
    `- **Probes executed:** ${String(outcomes.length)}`,
    "",
    "## Leak count",
    "",
    `**${String(leaks.value)}**, summed over ${String(leaks.sampleSize)} probes.`,
    "",
    "A leak is a chunk the probe set says this principal must never see that reached the candidate",
    "set — cited or not, because PRD 6.2 forbids materialising an unreadable chunk into the prompt",
    "at all. The count is a sum rather than a rate: adding clean probes must not make a leak look",
    "smaller.",
    "",
    leaks.value === 0
      ? "The gate passed. PRD 8.4 makes a non-zero count a build failure rather than a caveat, so a" +
        " run that leaked would not have produced this file."
      : `**${String(leaks.value)} leak(s). This blocks promotion outright (PRD 8.4).**`,
    "",
    "## Prompt-injection subset",
    "",
    ...(injection.length === 0
      ? [
          "**No probe in this set is marked as an injection probe.** PRD 8.1 item 4 folds the",
          "injection corpus from 6.5 into the permission probe set, so a set without one leaves this",
          "row of PRD 12 item 3 unevidenced — the leak count above says nothing about injection.",
        ]
      : [
          `- **Injection probes:** ${String(injection.length)}`,
          `- **Leaks within the subset:** ${String(injectionLeaks.length)}`,
          "",
          "The defence these probes exercise is not detection. A passage cannot close its own prompt",
          "block, and an answer that cites a chunk the model was not shown fails verification — so an",
          "injection that works still cannot produce a released answer. The unit tests in",
          "`packages/grounding` exercise that directly against a corpus of injection passages; this",
          "subset is the same property measured end to end.",
        ]),
    "",
    "## Existence disclosure",
    "",
    `**${String(disclosures.value)}** over ${String(disclosures.sampleSize)} probes.`,
    "",
    "Counted separately from leaks because no content escaped: what escaped is that content exists,",
    "which for a `hidden` source is the enumeration oracle PRD 6.4 closes. It has its own count",
    "because it has its own fix.",
    "",
    "## Audit-record schema",
    "",
    ...(schema.length === 0
      ? ["No audit record was produced by this run, so the schema could not be derived."]
      : [
          "Derived from a record this run actually wrote, rather than transcribed — a hand-written",
          "field list is a second copy of the contract, and the second copy is the one that goes",
          "stale.",
          "",
          ...schema.map((field) => `- \`${field}\``),
        ]),
    "",
    "## What this artefact does and does not support",
    "",
    "A leak count measures the permission pre-filter, which is ordinary code with no model in it,",
    "so this number is a measurement of the system that ships rather than of a stand-in. That is",
    "unusual in this build and is the reason this artefact is stated without qualification.",
    "",
    "It supports no claim about retrieval quality, answer quality, cost or latency. Those depend on",
    "models this repository does not install, and PRD 12's other required artefacts remain",
    "outstanding — see `docs/promotion-readiness.md`.",
    "",
  ];

  return lines.join("\n");
}
