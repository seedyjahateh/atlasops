/**
 * Spans and traces (PRD 9.2).
 *
 * Every request carries a span per stage; model-calling spans additionally carry the model
 * identifier, token counts, computed cost, cache-hit status and retry count.
 *
 * Spans nest, and the aggregation therefore reports **self time as well as inclusive time**. A
 * breakdown that only sums inclusive durations double-counts every parent and produces a total
 * larger than the request — which is the shape of number that makes people distrust the whole
 * dashboard. PRD 9.3 budgets a stage; it is self time that a stage is responsible for.
 *
 * A trace that is finished with a span still open throws. The alternative is a forgotten `end()`
 * silently removing that stage's cost from the breakdown, and an under-report is far worse than a
 * crash here: the budget passes and nobody looks again.
 */

import { AtlasOpsError, type RequestId } from "@atlasops/contracts";

import type { Clock } from "./clock.js";
import { totalCost, type CostRecord } from "./prices.js";
import { STAGE_GROUPS, type Stage, type StageGroup } from "./stages.js";

export interface ModelCall {
  readonly modelId: string;
  readonly cost: CostRecord;
  readonly cacheHit: boolean;
  readonly retries: number;
}

export interface Span {
  readonly id: number;
  readonly parentId: number | null;
  readonly stage: Stage;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly model: ModelCall | null;
  /** Set when this stage ran in one of PRD 9.4's degraded modes. */
  readonly degraded: boolean;
}

export interface Trace {
  readonly requestId: RequestId;
  readonly spans: readonly Span[];
  readonly totalMs: number;
  /** True when any span ran degraded, so the answer can be marked without rescanning. */
  readonly degraded: boolean;
}

export interface SpanEnd {
  readonly model?: ModelCall;
  readonly degraded?: boolean;
}

export interface SpanHandle {
  /** Idempotent: ending twice is a programming error and throws rather than double-counting. */
  readonly end: (detail?: SpanEnd) => void;
}

export interface TraceRecorder {
  readonly span: (stage: Stage) => SpanHandle;
  readonly finish: () => Trace;
}

export function createTrace(requestId: RequestId, clock: Clock): TraceRecorder {
  const spans: Span[] = [];
  const open: number[] = [];
  const pending = new Map<number, { stage: Stage; startedAt: number; parentId: number | null }>();
  const startedAt = clock.now();
  let nextId = 0;
  let finished = false;

  return {
    span(stage: Stage): SpanHandle {
      if (finished) {
        throw new AtlasOpsError("VALIDATION", `cannot open a "${stage}" span on a finished trace`);
      }
      const id = nextId++;
      pending.set(id, { stage, startedAt: clock.now(), parentId: open.at(-1) ?? null });
      open.push(id);

      let ended = false;
      return {
        end(detail?: SpanEnd): void {
          if (ended) {
            throw new AtlasOpsError("VALIDATION", `the "${stage}" span was ended twice`);
          }
          const record = pending.get(id);
          if (record === undefined) {
            throw new AtlasOpsError("VALIDATION", `no open span for "${stage}"`);
          }
          ended = true;
          pending.delete(id);

          const index = open.lastIndexOf(id);
          if (index !== -1) open.splice(index, 1);

          const endedAt = clock.now();
          spans.push({
            id,
            parentId: record.parentId,
            stage,
            startedAt: record.startedAt,
            endedAt,
            durationMs: endedAt - record.startedAt,
            model: detail?.model ?? null,
            degraded: detail?.degraded ?? false,
          });
        },
      };
    },

    finish(): Trace {
      if (finished) throw new AtlasOpsError("VALIDATION", "the trace was finished twice");
      if (pending.size > 0) {
        const names = [...pending.values()].map((entry) => entry.stage).sort();
        throw new AtlasOpsError(
          "VALIDATION",
          `the trace was finished with ${String(pending.size)} span(s) still open: ` +
            `${names.join(", ")}. A forgotten end() removes that stage from the breakdown, so the ` +
            `budget passes and nobody looks again.`,
        );
      }
      finished = true;
      const ordered = [...spans].sort((a, b) => a.id - b.id);
      return {
        requestId,
        spans: ordered,
        totalMs: clock.now() - startedAt,
        degraded: ordered.some((span) => span.degraded),
      };
    },
  };
}

/* ----------------------------------------------------------------------------- aggregation */

export interface StageTiming {
  readonly stage: Stage;
  /** Time inside this stage and everything it called. */
  readonly inclusiveMs: number;
  /** Time inside this stage but not inside its direct children. What the stage is answerable for. */
  readonly selfMs: number;
  readonly count: number;
}

export function stageBreakdown(trace: Trace): readonly StageTiming[] {
  const childDuration = new Map<number, number>();
  for (const span of trace.spans) {
    if (span.parentId === null) continue;
    childDuration.set(span.parentId, (childDuration.get(span.parentId) ?? 0) + span.durationMs);
  }

  const totals = new Map<Stage, { inclusiveMs: number; selfMs: number; count: number }>();
  for (const span of trace.spans) {
    const entry = totals.get(span.stage) ?? { inclusiveMs: 0, selfMs: 0, count: 0 };
    entry.inclusiveMs += span.durationMs;
    entry.selfMs += span.durationMs - (childDuration.get(span.id) ?? 0);
    entry.count += 1;
    totals.set(span.stage, entry);
  }

  return [...totals.entries()]
    .map(([stage, entry]) => ({ stage, ...entry }))
    .sort((a, b) => b.selfMs - a.selfMs);
}

/** Inclusive time for a named group from PRD 9.3, such as retrieval's "both arms + fusion". */
export function groupDuration(trace: Trace, group: StageGroup): number {
  const members = new Set<string>(STAGE_GROUPS[group]);
  return trace.spans
    .filter((span) => members.has(span.stage))
    .reduce((sum, span) => sum + span.durationMs, 0);
}

export function traceCost(trace: Trace): number {
  return totalCost(trace.spans.flatMap((span) => (span.model === null ? [] : [span.model.cost])));
}

export function costByStage(trace: Trace): ReadonlyMap<Stage, number> {
  const totals = new Map<Stage, number>();
  for (const span of trace.spans) {
    if (span.model === null) continue;
    totals.set(span.stage, (totals.get(span.stage) ?? 0) + span.model.cost.amountUsd);
  }
  return totals;
}

/** Cache hit rate for model-calling spans, or null when there were none to rate. */
export function cacheHitRate(trace: Trace): number | null {
  const calls = trace.spans.filter((span) => span.model !== null);
  if (calls.length === 0) return null;
  return calls.filter((span) => span.model?.cacheHit === true).length / calls.length;
}
