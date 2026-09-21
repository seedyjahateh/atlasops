/**
 * The evaluation artefact (PRD 8, PRD 12).
 *
 * "This section specifies method only. It contains no results, and must not be edited to contain
 * results — results live in versioned evaluation artefacts referenced from the manifest's
 * `evidence` array."
 *
 * This renders that artefact. Three things it always prints, because the ways a report misleads are
 * more reliable than the ways it informs:
 *
 * **The dataset versions and corpus snapshot, at the top.** A metric without them is not a claim
 * about anything, and a report that buries them in a footer gets quoted without them.
 *
 * **The sample size beside every number.** A rate over four queries and a rate over four hundred
 * are printed identically otherwise, and the first one is what somebody screenshots.
 *
 * **The rows that could not be measured, with the reason.** A missing row reads as a clean run.
 *
 * It is Markdown rather than JSON because its audience is a reviewer, and it is generated rather
 * than written because a hand-written summary of a run is a place for a number to improve on its
 * way out.
 */

import type { ComparisonReport } from "./compare.js";
import type { RunReport } from "./harness.js";
import { describeJudge } from "./judge.js";
import type { MetricResult } from "./metric.js";

function round(value: number, places = 4): string {
  const factor = Math.pow(10, places);
  return String(Math.round(value * factor) / factor);
}

function metricLine(metric: MetricResult): string {
  return `| ${metric.metric} | ${round(metric.value)} | ${String(metric.sampleSize)} | ${metric.aggregation} |`;
}

export function renderRunReport(report: RunReport): string {
  const lines: string[] = [
    `# Evaluation run ${report.runId}`,
    "",
    `- **System:** ${report.system}`,
    `- **Arm:** ${report.arm}`,
    `- **Commit:** ${report.commit ?? "not recorded"}`,
    `- **Measured at:** ${report.measuredAt}`,
    `- **Judge:** ${report.judge === null ? "none" : describeJudge(report.judge)}`,
    "",
    "## Models",
    "",
    ...(Object.keys(report.models).length === 0
      ? [
          "_No model identifiers were recorded._ PRD 12 item 2 requires them, and a run without",
          "them produces numbers nobody can attribute.",
        ]
      : Object.entries(report.models)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([role, id]) => `- **${role}:** \`${id}\``)),
    "",
    "Runs per arm: 1. PRD 8.5 asks for repeated runs with reported variance where a system cannot",
    "be made deterministic; every model in this build is a deterministic stand-in, so repetition",
    "would produce identical numbers and a variance of zero that means nothing.",
    "",
    "## Datasets",
    "",
    ...(report.datasets.length === 0
      ? ["No dataset was supplied. Nothing below is a measurement of anything."]
      : report.datasets.map((dataset) => `- ${dataset}`)),
    "",
    `Splits evaluated: ${report.splits.join(", ")}.`,
    ...(report.splits.includes("held-out") ? ["", "> This run read the held-out split."] : []),
    "",
    "## Metrics",
    "",
  ];

  for (const row of report.table) {
    lines.push(`### ${row.dimension}`, "");
    if (row.metrics.length === 0) {
      lines.push(`_Not measured: ${row.unavailable ?? "no reason recorded"}._`, "");
      continue;
    }
    lines.push("| Metric | Value | Queries | Aggregation |", "| --- | --- | --- | --- |");
    for (const metric of row.metrics) lines.push(metricLine(metric));
    lines.push("");
  }

  lines.push("## Latency", "");
  if (report.latency.length === 0) {
    lines.push("_No timings were recorded._", "");
  } else {
    lines.push("| Stage | p50 (ms) | p95 (ms) | Samples |", "| --- | --- | --- | --- |");
    for (const row of report.latency) {
      lines.push(
        `| ${row.stage} | ${round(row.p50, 1)} | ${round(row.p95, 1)} | ${String(row.samples)} |`,
      );
    }
    // PRD 9.1's warning, printed where the number is rather than in a document nobody opens.
    if (report.latency.some((row) => row.samples <= 20)) {
      lines.push(
        "",
        "> A nearest-rank p95 over twenty samples or fewer **is** the maximum. The p95 above is a",
        "> maximum wearing a percentile's name.",
      );
    }
    lines.push("");
  }

  lines.push(
    "## Governance",
    "",
    report.governance === null
      ? "_No permission probe set was supplied, so no governance gate ran._"
      : `Leak count **${round(report.governance.leaks.value)}** over ` +
          `${String(report.governance.leaks.sampleSize)} probes; existence disclosures ` +
          `**${round(report.governance.disclosures.value)}**. The run reached this report, so the ` +
          `leak gate passed — PRD 8.4 makes a leak a build failure rather than a number printed here.`,
    "",
    `## Per-query results`,
    "",
    `${String(report.perQuery.length)} records retained. PRD 8.5 requires them for the paired`,
    `comparison; they are the artefact's payload, not an appendix.`,
    "",
  );

  return lines.join("\n");
}

export function renderComparison(comparison: ComparisonReport): string {
  const lines: string[] = [
    `# Comparison ${comparison.candidate} against ${comparison.baseline}`,
    "",
    `**Verdict: ${comparison.verdict}. Gate ${comparison.passed ? "passed" : "failed"}.**`,
    "",
    comparison.reason,
    "",
    `Tolerance ${round(comparison.gate.tolerance)} (${comparison.gate.provenance}).`,
    "",
    "| Metric | Δ (point) | CI lower | CI upper | Pairs | Verdict | Gate |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const metric of comparison.metrics) {
    const { bootstrap } = metric;
    lines.push(
      `| ${metric.metric}${metric.lowerIsBetter ? " ↓" : ""} | ${round(bootstrap.mean)} | ` +
        `${round(bootstrap.lower)} | ${round(bootstrap.upper)} | ` +
        `${String(bootstrap.sampleSize)} | ${metric.verdict} | ` +
        `${metric.passesGate ? "pass" : "fail"} |`,
    );
  }

  const first = comparison.metrics[0]?.bootstrap;
  lines.push(
    "",
    first === undefined
      ? ""
      : `Intervals are ${round(first.confidence * 100, 1)}% percentile bootstrap over ` +
          `${String(first.resamples)} resamples, seed ${String(first.seed)}. The gate reads the ` +
          `lower bound, not the point estimate (PRD 8.5).`,
    "",
    "A metric marked ↓ is one where a larger number is worse; its delta is sign-corrected above,",
    "so a positive delta means better in every row.",
    "",
  );

  return lines.join("\n");
}
