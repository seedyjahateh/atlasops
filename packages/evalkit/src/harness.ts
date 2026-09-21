/**
 * The evaluation harness (PRD 8.2, 8.5).
 *
 * It drives an answer system across one dataset version and emits the metric table together with
 * **the per-query record every number came from**. PRD 8.5 requires those records for the paired
 * bootstrap, and a harness that reported only aggregates would make the regression gate
 * unimplementable one phase later.
 *
 * **The system under test is a port.** `evalkit` cannot import `indexing`, `corpus`, `ingest` or
 * `model-gateway` (PRD 11.2), so it cannot assemble a pipeline even if it wanted to — and it should
 * not want to. A harness that could only evaluate this repository's own wiring could not be used to
 * evaluate a change to that wiring, which is the one thing it exists for.
 *
 * **A dimension that could not be measured says so.** The table carries a row per PRD 8.2
 * dimension, and a row without its dataset, or without a judge, is returned with the reason rather
 * than omitted. A missing row in a report reads as a clean run; a row that says "no permission
 * probe set was supplied" does not.
 *
 * **The governance gate runs inside the harness**, not beside it. PRD 8.4 makes a leak a build
 * failure rather than a score, so a run that leaked does not produce a report with a bad number in
 * it — it does not produce a report.
 */

import { contentHashOf } from "@atlasops/contracts";
import type { GroundingResult } from "@atlasops/grounding";
import type { FusedCandidate, RetrievalConfig, RetrievalResult } from "@atlasops/retrieval";
import { percentile, type PriceTable } from "@atlasops/telemetry";

import { correctAbstentionRate, overAbstentionRate } from "./abstention-metrics.js";
import { configForArm, type ArmName } from "./arms.js";
import { citationPrecision, citationRecall, spanValidityRate } from "./citation-metrics.js";
import { datasetRef, type Dataset } from "./dataset.js";
import { assertNoLeaks, type GovernanceGate } from "./governance-metrics.js";
import { judgedMetrics, type Judge, type JudgeIdentity, type JudgedOutcome } from "./judge.js";
import { metricResult, type MetricResult } from "./metric.js";
import {
  meanReciprocalRank,
  ndcgAt,
  perRetrieverContribution,
  recallAt,
} from "./retrieval-metrics.js";
import type {
  AbstentionItem,
  GroundedAnswerItem,
  PermissionProbeItem,
  RelevanceItem,
} from "./shapes.js";

export interface SystemQuery {
  readonly itemId: string;
  readonly query: string;
  /** The principal identifier the dataset names. The system resolves it to groups. */
  readonly principal: string;
  readonly config: RetrievalConfig;
}

export interface SystemObservation {
  readonly retrieval: RetrievalResult;
  readonly grounding: GroundingResult;
}

export interface AnswerSystem {
  readonly name: string;
  readonly answer: (query: SystemQuery) => Promise<SystemObservation>;
}

/** The raw per-query result PRD 8.5 requires to be retained. */
export interface QueryRecord {
  readonly itemId: string;
  readonly arm: ArmName;
  readonly query: string;
  readonly principal: string;
  readonly abstained: boolean;
  /** Every chunk that reached the candidate set, cited or not. */
  readonly candidateChunks: readonly string[];
  readonly citedChunks: readonly string[];
  readonly message: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly degraded: readonly string[];
}

export interface TableRow {
  readonly dimension: string;
  readonly metrics: readonly MetricResult[];
  /** Why this row is empty, when it is. Never omitted silently. */
  readonly unavailable: string | null;
}

export interface LatencyRow {
  readonly stage: string;
  readonly p50: number;
  readonly p95: number;
  readonly samples: number;
}

export interface RunReport {
  /** Derived from what was run, so two identical runs name themselves identically. */
  readonly runId: string;
  readonly system: string;
  readonly arm: ArmName;
  readonly datasets: readonly string[];
  /**
   * Which splits this run actually evaluated.
   *
   * The harness evaluates whatever items it is handed — the seal governs who can obtain held-out
   * items, not what the harness does with them — so the report records which splits it saw. An
   * artefact that read the held-out split then says so on its face, rather than leaving a reader
   * to work it out from a dataset reference.
   */
  readonly splits: readonly string[];
  readonly table: readonly TableRow[];
  readonly latency: readonly LatencyRow[];
  /** Null when no model in the run had a price. See ADR 0002. */
  readonly costPerAnswer: MetricResult | null;
  readonly perQuery: readonly QueryRecord[];
  readonly governance: GovernanceGate | null;
  readonly judge: JudgeIdentity | null;
  readonly measuredAt: string;
}

export interface RunInput {
  readonly system: AnswerSystem;
  readonly arm: ArmName;
  readonly baseConfig: RetrievalConfig;
  // Explicitly `| undefined` rather than merely optional: under `exactOptionalPropertyTypes` an
  // options bag assembled by a caller — which is what a runner does — cannot otherwise say "no
  // probe set" without deleting a key. Omitting one and passing undefined mean the same thing
  // here, and both mean the corresponding row of the 8.2 table reports why it is empty.
  readonly relevance?: Dataset<RelevanceItem> | undefined;
  readonly grounded?: Dataset<GroundedAnswerItem> | undefined;
  readonly abstention?: Dataset<AbstentionItem> | undefined;
  readonly probes?: Dataset<PermissionProbeItem> | undefined;
  readonly judge?: Judge | undefined;
  readonly prices?: PriceTable | undefined;
  readonly now: () => string;
}

function recordOf(
  itemId: string,
  arm: ArmName,
  query: string,
  principal: string,
  observation: SystemObservation,
): QueryRecord {
  const { retrieval, grounding } = observation;
  return {
    itemId,
    arm,
    query,
    principal,
    abstained: grounding.answer.abstained,
    candidateChunks: retrieval.candidates.map((candidate) => candidate.chunkId),
    citedChunks: grounding.audit.citedChunks.map((entry) => entry.chunkId),
    message: grounding.message,
    latencyMs: retrieval.trace.totalMs,
    inputTokens: grounding.audit.inputTokens,
    outputTokens: grounding.audit.outputTokens,
    costUsd: grounding.audit.costUsd,
    degraded: retrieval.degraded,
  };
}

function blocksOf(grounding: GroundingResult): readonly { chunkId: string; text: string }[] {
  return grounding.prompt.blocks.map((block) => ({ chunkId: block.chunkId, text: block.text }));
}

export async function runEvaluation(input: RunInput): Promise<RunReport> {
  const config = configForArm(input.baseConfig, input.arm);
  const records: QueryRecord[] = [];
  const datasets: string[] = [];
  const table: TableRow[] = [];
  const splits = new Set<string>();

  for (const dataset of [input.relevance, input.grounded, input.abstention, input.probes]) {
    for (const item of dataset?.items ?? []) splits.add(item.split);
  }

  const ask = async (
    itemId: string,
    query: string,
    principal: string,
  ): Promise<SystemObservation> => {
    const observation = await input.system.answer({ itemId, query, principal, config });
    records.push(recordOf(itemId, input.arm, query, principal, observation));
    return observation;
  };

  /* ------------------------------------------------------------------- retrieval + fusion */

  if (input.relevance === undefined) {
    table.push({
      dimension: "Retrieval",
      metrics: [],
      unavailable: "no relevance dataset was supplied",
    });
    table.push({
      dimension: "Fusion and rerank",
      metrics: [],
      unavailable: "no relevance dataset was supplied",
    });
  } else {
    datasets.push(datasetRef(input.relevance));
    const items = input.relevance.items;
    const ranked: { itemId: string; ranked: readonly string[] }[] = [];
    const fused: { itemId: string; candidates: readonly FusedCandidate[] }[] = [];

    for (const item of items) {
      const observation = await ask(item.id, item.query, item.principal);
      ranked.push({
        itemId: item.id,
        ranked: observation.retrieval.candidates.map((candidate) => candidate.chunkId),
      });
      fused.push({ itemId: item.id, candidates: observation.retrieval.candidates });
    }

    table.push({
      dimension: "Retrieval",
      metrics: [
        recallAt(10, items, ranked),
        ndcgAt(10, items, ranked),
        meanReciprocalRank(items, ranked),
        ...perRetrieverContribution(items, fused),
      ],
      unavailable: null,
    });
    // The ablated comparison is the point of this row, and it is a property of several runs
    // rather than of one. `compareArms` fills it; a single run reports which arm it was.
    table.push({
      dimension: "Fusion and rerank",
      metrics: [],
      unavailable: `this run is the "${input.arm}" arm; the deltas are a comparison across arms`,
    });
  }

  /* -------------------------------------------------------------- citation + groundedness */

  if (input.grounded === undefined) {
    for (const dimension of ["Citation", "Groundedness"]) {
      table.push({
        dimension,
        metrics: [],
        unavailable: "no grounded-answer dataset was supplied",
      });
    }
  } else {
    datasets.push(datasetRef(input.grounded));
    const items = input.grounded.items;
    const answers: {
      itemId: string;
      answer: GroundingResult["answer"];
      blocks: readonly { chunkId: string; text: string }[];
    }[] = [];
    const judged: JudgedOutcome[] = [];

    for (const item of items) {
      const observation = await ask(item.id, item.query, item.principal);
      answers.push({
        itemId: item.id,
        answer: observation.grounding.answer,
        blocks: blocksOf(observation.grounding),
      });

      if (input.judge !== undefined) {
        const cited = new Set(
          observation.grounding.audit.citedChunks.map((entry) => entry.chunkId as string),
        );
        judged.push({
          itemId: item.id,
          judgement: await input.judge.judge({
            itemId: item.id,
            query: item.query,
            referenceAnswer: item.referenceAnswer,
            answerProse: observation.grounding.prose,
            citedText: blocksOf(observation.grounding)
              .filter((block) => cited.has(block.chunkId))
              .map((block) => block.text),
          }),
        });
      }
    }

    table.push({
      dimension: "Citation",
      metrics: [
        citationPrecision(items, answers),
        citationRecall(items, answers),
        spanValidityRate(answers),
      ],
      unavailable: null,
    });

    if (input.judge === undefined) {
      table.push({
        dimension: "Groundedness",
        metrics: [],
        unavailable: "no judge was supplied; PRD 8.3 does not permit these to be string-matched",
      });
    } else {
      const results = judgedMetrics(items, judged, input.judge.identity);
      table.push({
        dimension: "Groundedness",
        metrics: [results.supportedClaimRate, results.contradictionRate, results.agreement],
        unavailable: null,
      });
    }
  }

  /* ------------------------------------------------------------------------- abstention */

  if (input.abstention === undefined) {
    table.push({
      dimension: "Abstention",
      metrics: [],
      unavailable: "no abstention dataset was supplied",
    });
  } else {
    datasets.push(datasetRef(input.abstention));
    const items = input.abstention.items;
    const outcomes: { itemId: string; abstained: boolean }[] = [];

    for (const item of items) {
      const observation = await ask(item.id, item.query, item.principal);
      outcomes.push({ itemId: item.id, abstained: observation.grounding.answer.abstained });
    }

    table.push({
      dimension: "Abstention",
      metrics: [correctAbstentionRate(items, outcomes), overAbstentionRate(items, outcomes)],
      unavailable: null,
    });
  }

  /* ------------------------------------------------------------------------- governance */

  let governance: GovernanceGate | null = null;

  if (input.probes === undefined) {
    table.push({
      dimension: "Governance",
      metrics: [],
      unavailable: "no permission probe set was supplied",
    });
  } else {
    datasets.push(datasetRef(input.probes));
    const items = input.probes.items;
    const outcomes: { itemId: string; materialised: readonly string[]; message: string }[] = [];

    for (const item of items) {
      const observation = await ask(item.id, item.query, item.principal);
      outcomes.push({
        itemId: item.id,
        // Everything that reached the candidate set, not only what was cited (PRD 6.2).
        materialised: observation.retrieval.candidates.map((candidate) => candidate.chunkId),
        message: observation.grounding.message,
      });
    }

    // Throws on a leak. A run that leaked does not get a report with a bad number in it.
    governance = assertNoLeaks(items, outcomes);
    table.push({
      dimension: "Governance",
      metrics: [governance.leaks, governance.disclosures],
      unavailable: null,
    });
  }

  /* -------------------------------------------------------------------- cost and latency */

  const latency: LatencyRow[] = [];
  const byStage = new Map<string, number[]>();
  for (const record of records) {
    const all = byStage.get("end-to-end") ?? [];
    all.push(record.latencyMs);
    byStage.set("end-to-end", all);
  }
  for (const [stage, values] of byStage) {
    latency.push({
      stage,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      samples: values.length,
    });
  }

  // Null rather than zero when anything in the run was unpriced (ADR 0002). A mean over the
  // priced subset would be a cost per answer for a different set of answers.
  const priced = records.every((record) => record.costUsd !== null);
  const costPerAnswer =
    priced && records.length > 0
      ? metricResult(
          "cost-per-answer",
          records.map((record) => ({ itemId: record.itemId, value: record.costUsd ?? 0 })),
        )
      : null;

  table.push({
    dimension: "Cost and latency",
    metrics: costPerAnswer === null ? [] : [costPerAnswer],
    unavailable:
      costPerAnswer === null
        ? "at least one model in this run has no price in the table in force (ADR 0002)"
        : null,
  });

  return {
    runId: contentHashOf(
      [input.system.name, input.arm, ...datasets, String(records.length)].join("\u001f"),
    ),
    system: input.system.name,
    arm: input.arm,
    datasets,
    splits: [...splits].sort(),
    table,
    latency,
    costPerAnswer,
    perQuery: records,
    governance,
    judge: input.judge?.identity ?? null,
    measuredAt: input.now(),
  };
}

/** Every metric in a report, flattened, for a comparison to walk. */
export function metricsOf(report: RunReport): readonly MetricResult[] {
  return report.table.flatMap((row) => row.metrics);
}
