/**
 * The cost and latency report (PRD 12 item 4).
 *
 * It is rendered from the committed record rather than from a live run, so the artefact and the
 * thing CI checks cannot disagree. Everything a reader needs to dispute a number is in it: the
 * profile, the sample sizes, the stage breakdown, and — in the same table as the measured rows —
 * every budget this run could not measure, with the reason.
 */

import type { BudgetRow, LoadRunRecord } from "./measure.js";

function round(value: number, places = 2): string {
  const factor = 10 ** places;
  return String(Math.round(value * factor) / factor);
}

function budgetCell(row: BudgetRow): string {
  if (row.value === null) return "**not measured**";
  const verdict = row.within === true ? "within" : "**over**";
  return `${round(row.value, 4)} ${row.unit} (${verdict})`;
}

export function renderLoadReport(record: LoadRunRecord): string {
  const { profile } = record;
  const measured = record.budgets.filter((row) => row.value !== null);
  const unmeasured = record.budgets.filter((row) => row.value === null);

  const lines = [
    "# Cost and latency report",
    "",
    "PRD 12 item 4. Produced by `pnpm loadrun`, from the reference profile PRD 9.1 requires.",
    "",
    "## Reference profile",
    "",
    `- **Profile:** ${profile.id}`,
    `- **Corpus snapshot:** ${profile.corpusSnapshot}`,
    `- **Workload:** ${profile.workload}`,
    `- **Concurrency:** ${String(profile.concurrency)} (sustained, worker pool — not a burst)`,
    `- **Hardware:** ${profile.hardware}`,
    `- **Models:** ${Object.entries(profile.models)
      .map(([role, id]) => `${role}=${id}`)
      .join(", ")}`,
    `- **Commit:** ${record.commit ?? "not recorded"}`,
    `- **Run:** ${record.startedAt} → ${record.finishedAt}`,
    `- **Requests:** ${String(record.requests)} (${String(record.abstentions)} abstained)`,
    "",
    "## What this run measured, and what it did not",
    "",
    "**No request left this machine.** No provider adapter is wired into these processes, so the",
    "embedder, reranker and generator are the in-repo stand-ins named above. The permission,",
    "retrieval and verification stages below are the code that ships and their timings are real.",
    "The generation stage is a local function call, so the end-to-end figure omits the largest",
    "component a deployed system would have — it is a floor, not an estimate.",
    "",
    `**${String(record.retrievalCacheHits)} of ${String(record.requests)} requests were served from the ` +
      `retrieval cache** (${String(Math.round(record.retrievalCacheHitRate * 100))}%), because the`,
    "workload repeats and a repeated query for the same principal is the case the cache exists for.",
    "That makes the combined end-to-end figure mostly a measurement of a cache lookup, so the table",
    "below reports the cache-miss and cache-hit populations separately. They are different pieces of",
    "work and averaging them produces a number that describes neither.",
    "",
    "PRD 9.2 asks for hit rate **by cache**, and this run can answer for one of the two. The",
    "embedding cache's hits happen inside retrieval and are reported to it rather than to this",
    "harness, so its rate is absent rather than guessed.",
    "",
    "## Budgets (PRD 9.3)",
    "",
    "| Budget | Target | This run | Samples | Method |",
    "| ------ | ------ | -------- | ------- | ------ |",
    ...record.budgets.map(
      (row) =>
        `| ${row.id} | ${round(row.target, 4)} ${row.unit} | ${budgetCell(row)} | ` +
        `${row.sampleSize === null ? "—" : String(row.sampleSize)} | ${row.method} |`,
    ),
    "",
    `${String(measured.length)} of ${String(record.budgets.length)} budgets were measured. A budget that was ` +
      "exceeded is reported with the stage breakdown below and **is not raised to make the build",
    "pass** (PRD 9.3).",
    "",
  ];

  const caveats = record.budgets.filter((row) => row.caveat !== null);
  if (caveats.length > 0) {
    lines.push(
      "### What these figures do not say about themselves",
      "",
      ...caveats.map((row) => `- **${row.id}** — ${row.caveat ?? ""}`),
      "",
    );
  }

  if (unmeasured.length > 0) {
    lines.push(
      "### Why the rest could not be measured",
      "",
      "Listed rather than omitted: a report that dropped the rows it could not fill would read as a",
      "clean sheet.",
      "",
      ...unmeasured.map((row) => `- **${row.id}** — ${row.unmeasured ?? "no reason recorded"}`),
      "",
    );
  }

  lines.push(
    "## Latency by stage",
    "",
    "Self time per request, summed across the spans a request produced for that stage — so each",
    "request contributes one sample and a request with three spans cannot outvote one with a single",
    "span.",
    "",
    "| Stage | p50 (ms) | p95 (ms) | Samples |",
    "| ----- | -------- | -------- | ------- |",
    ...record.latency.map(
      (row) =>
        `| ${row.stage} | ${round(row.p50)} | ${round(row.p95)}${row.p95IsMaximum ? " †" : ""} | ` +
        `${String(row.samples)} |`,
    ),
    "",
    "† The p95 rests on twenty samples or fewer, where nearest-rank returns the maximum. It is the",
    "largest value observed wearing a percentile's name, and a larger run would be needed before it",
    "means anything else.",
    "",
    "## Cost",
    "",
    `Ingestion wrote ${String(record.chunksIngested)} chunks in this run, and the token counts for every`,
    "model call were recorded. **No cost figure is produced**, because the price table in force",
    "prices no stand-in (ADR 0002). The ratio of ingestion to serving cost that PRD 9.2 asks for is",
    "unavailable for the same reason: both halves are token counts and neither has a price.",
    "",
    "## What this artefact does not support",
    "",
    "It does not support any claim about the latency or cost of a deployed system. It measures a",
    "pipeline whose model calls are local, on one machine, at one concurrency, over a synthetic",
    "corpus. PRD 12 item 4 requires this report **against a run with real models**, and until such",
    "a run exists that item remains unmet — see `docs/promotion-readiness.md`.",
    "",
  );

  return lines.join("\n");
}
