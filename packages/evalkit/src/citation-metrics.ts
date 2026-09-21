/**
 * Citation metrics (PRD 8.2, row 3).
 *
 * Citation precision and recall are set comparisons against the chunks a labeller said legitimately
 * support the answer. Span-validity is the share of references whose span actually lies inside the
 * passage the model was shown.
 *
 * **Span-validity is 1 by construction over released answers**, because an answer with an
 * out-of-range span fails PRD 7.2's verification and abstains. That is not a reason to drop the
 * metric — it is the reason to be careful about what it is computed over. Run against released
 * answers it asserts that the gate held; run against the model's *attempts*, which
 * `GroundingResult.verifications` retains, it measures the generator. A test asserts both readings,
 * because a metric that is silently always 1 is worse than no metric: it looks like evidence.
 *
 * An abstention is scored as neither a hit nor a miss on precision — it cites nothing, so there is
 * no precision to measure — and as a miss on recall, because the supporting material existed and
 * the answer did not reach it. Scoring precision as 1 for an abstention would make a system that
 * never answers perfectly precise.
 */

import type { Answer } from "@atlasops/contracts";

import { metricResult, type MetricResult, type PerQueryScore } from "./metric.js";
import type { GroundedAnswerItem } from "./shapes.js";

export interface AnswerOutcome {
  readonly itemId: string;
  readonly answer: Answer;
  /** The passages the model was shown, so a span can be checked against what it read. */
  readonly blocks: readonly { readonly chunkId: string; readonly text: string }[];
}

function citedChunks(answer: Answer): readonly string[] {
  if (answer.abstained) return [];
  return [
    ...new Set(
      answer.segments.flatMap((segment) =>
        segment.references.map((reference) => reference.chunkId as string),
      ),
    ),
  ];
}

export function citationPrecision(
  items: readonly GroundedAnswerItem[],
  outcomes: readonly AnswerOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome]));

  const perQuery: PerQueryScore[] = items.flatMap((item) => {
    const outcome = byId.get(item.id);
    if (outcome === undefined) return [];

    const cited = citedChunks(outcome.answer);
    // An abstention cites nothing. It is excluded rather than scored 1 — see the file header.
    if (cited.length === 0) return [];

    const supporting = new Set(item.supportingChunks);
    const correct = cited.filter((chunkId) => supporting.has(chunkId));
    return [{ itemId: item.id, value: correct.length / cited.length }];
  });

  return metricResult("citation-precision", perQuery);
}

export function citationRecall(
  items: readonly GroundedAnswerItem[],
  outcomes: readonly AnswerOutcome[],
): MetricResult {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome]));

  const perQuery: PerQueryScore[] = items.map((item) => {
    const outcome = byId.get(item.id);
    const supporting = new Set(item.supportingChunks);
    if (supporting.size === 0) return { itemId: item.id, value: 0 };

    // An abstention scores zero here on purpose: the material existed and the answer did not
    // reach it, which is exactly what recall measures.
    const cited = outcome === undefined ? [] : citedChunks(outcome.answer);
    const found = cited.filter((chunkId) => supporting.has(chunkId));
    return { itemId: item.id, value: found.length / supporting.size };
  });

  return metricResult("citation-recall", perQuery);
}

export function spanValidityRate(outcomes: readonly AnswerOutcome[]): MetricResult {
  const perQuery: PerQueryScore[] = outcomes.flatMap((outcome) => {
    if (outcome.answer.abstained) return [];

    const shown = new Map(outcome.blocks.map((block) => [block.chunkId, block.text]));
    const references = outcome.answer.segments.flatMap((segment) => segment.references);
    if (references.length === 0) return [];

    const valid = references.filter((reference) => {
      const text = shown.get(reference.chunkId);
      if (text === undefined) return false;
      return reference.span.end <= text.length && reference.span.start < reference.span.end;
    });

    return [{ itemId: outcome.itemId, value: valid.length / references.length }];
  });

  return metricResult("span-validity", perQuery);
}
