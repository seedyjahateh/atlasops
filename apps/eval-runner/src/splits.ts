/**
 * Retrieval metrics per split, for a run that read the held-out split.
 *
 * **Why this exists.** A final evaluation (`--final "<reason>"`) evaluates the development and
 * held-out splits together, and every metric in its report pools them. That is the right number
 * for a report and the wrong one for a decision. The point of reading the held-out split is to see
 * whether something chosen on development items holds on items nobody chose it on, and a pooled
 * mean cannot show that: eleven development items outvote three held-out ones.
 *
 * So the breakdown is computed from the run's own per-query records with `evalkit`'s own metric
 * functions — the same definitions the report uses, over a narrower set of items. Nothing here
 * re-scores, re-ranks or calls a model. And because the development rows can be compared with a
 * development-only run of the same commit, the breakdown carries its own consistency check.
 *
 * **Small held-out splits are reported as what they are.** Per-query values are included, because
 * over three items a mean hides which item moved it. No confidence interval is drawn: a bootstrap
 * over three pairs resamples three numbers, and its interval would look like precision.
 */

import {
  meanReciprocalRank,
  ndcgAt,
  recallAt,
  type Dataset,
  type MetricResult,
  type RelevanceItem,
  type RunReport,
} from "@atlasops/evalkit";

export interface SplitMetrics {
  readonly split: string;
  readonly arm: string;
  readonly items: number;
  readonly metrics: readonly MetricResult[];
}

/** Recall@10, nDCG@10 and MRR for every arm, once per split the runs evaluated. */
export function retrievalBySplit(
  relevance: Dataset<RelevanceItem>,
  runs: readonly RunReport[],
): SplitMetrics[] {
  const splits = [...new Set(runs.flatMap((run) => run.splits))].sort();
  const rows: SplitMetrics[] = [];
  for (const split of splits) {
    const items = relevance.items.filter((item) => item.split === split);
    if (items.length === 0) continue;
    for (const run of runs) {
      const ranked = items.map((item) => ({
        itemId: item.id,
        ranked: run.perQuery.find((record) => record.itemId === item.id)?.candidateChunks ?? [],
      }));
      rows.push({
        split,
        arm: run.arm,
        items: items.length,
        metrics: [
          recallAt(10, items, ranked),
          ndcgAt(10, items, ranked),
          meanReciprocalRank(items, ranked),
        ],
      });
    }
  }
  return rows;
}

export function renderRetrievalBySplit(
  rows: readonly SplitMetrics[],
  context: { readonly commit: string | null; readonly corpusSnapshot: string },
): string {
  const lines = [
    "# Retrieval by split",
    "",
    `- **Commit:** ${context.commit ?? "not recorded"}`,
    `- **Corpus snapshot:** ${context.corpusSnapshot}`,
    "",
    "The run's reports pool every split it evaluated. This breaks retrieval out by split, from the",
    "same per-query records and the same metric definitions, so that a held-out result can be read",
    "on its own. Per-query nDCG@10 is listed because over a handful of items a mean hides which",
    "item moved it. No confidence interval is drawn: a bootstrap over a few pairs looks precise and",
    "is not.",
    "",
  ];
  for (const split of [...new Set(rows.map((row) => row.split))]) {
    const splitRows = rows.filter((row) => row.split === split);
    lines.push(
      `## ${split} (${String(splitRows[0]?.items ?? 0)} relevance items)`,
      "",
      "| Arm | recall@10 | nDCG@10 | MRR | nDCG@10 per query |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const row of splitRows) {
      const [recall, ndcg, mrr] = row.metrics;
      const perQuery = (ndcg?.perQuery ?? [])
        .map((score) => `${score.itemId} ${score.value.toFixed(4)}`)
        .join(", ");
      lines.push(
        `| ${row.arm} | ${(recall?.value ?? Number.NaN).toFixed(4)} | ` +
          `${(ndcg?.value ?? Number.NaN).toFixed(4)} | ${(mrr?.value ?? Number.NaN).toFixed(4)} | ${perQuery} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
