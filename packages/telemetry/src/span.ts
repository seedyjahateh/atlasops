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
import { STAGES, STAGE_GROUPS, type Stage, type StageGroup } from "./stages.js";

export interface ModelCall {
  readonly modelId: string;
  /**
   * Null when the price table in force does not price this model (ADR 0002).
   *
   * The same widening `AuditRecord.costUsd` took in P9, for the same reason and now for the same
   * caller: a span that had to carry a `CostRecord` could not be recorded at all for a stand-in,
   * so instrumenting generation would have meant either fabricating a zero — which makes every
   * cost budget pass trivially — or leaving the stage untraced, which is what it was.
   */
  readonly cost: CostRecord | null;
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
  /**
   * The spans closed so far, without closing the trace.
   *
   * For the one case that cannot wait for `finish`: a stage whose own work is writing the record
   * that carries the breakdown. The audit write cannot report its own duration inside the record
   * it is writing, and a breakdown assembled after `finish` would be too late to seal. What a
   * snapshot leaves out is exactly the span still open, which is why the audit says so.
   */
  readonly snapshot: () => Trace;
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

    snapshot(): Trace {
      const ordered = [...spans].sort((a, b) => a.id - b.id);
      return {
        requestId,
        spans: ordered,
        totalMs: clock.now() - startedAt,
        degraded: ordered.some((span) => span.degraded),
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

/**
 * Combines breakdowns from several traces into one, summing per stage.
 *
 * A request is traced in more than one place — the composition root times permission resolution,
 * retrieval traces its own arms, grounding traces generation and verification — and the audit has
 * to carry the whole request rather than whichever part the last writer happened to hold.
 *
 * Summing rather than concatenating is the point. A consumer handed the same stage twice adds it
 * twice, which is exactly the bug the P15 load run found: the harness concatenated the retrieval
 * breakdown with the audit's copy of it and reported every retrieval stage at double its time.
 */
export function mergeStageTimings(
  ...breakdowns: readonly (readonly StageTiming[])[]
): readonly StageTiming[] {
  const totals = new Map<Stage, { inclusiveMs: number; selfMs: number; count: number }>();

  for (const breakdown of breakdowns) {
    for (const timing of breakdown) {
      const entry = totals.get(timing.stage) ?? { inclusiveMs: 0, selfMs: 0, count: 0 };
      entry.inclusiveMs += timing.inclusiveMs;
      entry.selfMs += timing.selfMs;
      entry.count += timing.count;
      totals.set(timing.stage, entry);
    }
  }

  // In PRD 9.2's declared stage order rather than by size, because this is the shape a reader
  // follows through a request: normalise, resolve, retrieve, rerank, assemble, generate, verify.
  return STAGES.filter((stage) => totals.has(stage)).map((stage) => {
    const entry = totals.get(stage) ?? { inclusiveMs: 0, selfMs: 0, count: 0 };
    return { stage, ...entry };
  });
}

/** Inclusive time for a named group from PRD 9.3, such as retrieval's "both arms + fusion". */
export function groupDuration(trace: Trace, group: StageGroup): number {
  const members = new Set<string>(STAGE_GROUPS[group]);
  return trace.spans
    .filter((span) => members.has(span.stage))
    .reduce((sum, span) => sum + span.durationMs, 0);
}

/**
 * What the priced model calls in this trace cost.
 *
 * Unpriced calls contribute nothing and are not an error here, but a caller summing this across a
 * run needs `unpricedCalls` beside it — a total over a trace where half the calls had no price is
 * a real number describing half the work, and nothing in the figure itself says so.
 */
export function traceCost(trace: Trace): number {
  return totalCost(
    trace.spans.flatMap((span) => {
      const cost = span.model?.cost ?? null;
      return cost === null ? [] : [cost];
    }),
  );
}

/** How many model calls in this trace could not be priced (ADR 0002). */
export function unpricedCalls(trace: Trace): number {
  return trace.spans.filter((span) => span.model !== null && span.model.cost === null).length;
}

export function costByStage(trace: Trace): ReadonlyMap<Stage, number> {
  const totals = new Map<Stage, number>();
  for (const span of trace.spans) {
    const cost = span.model?.cost ?? null;
    if (cost === null) continue;
    totals.set(span.stage, (totals.get(span.stage) ?? 0) + cost.amountUsd);
  }
  return totals;
}

/** Cache hit rate for model-calling spans, or null when there were none to rate. */
export function cacheHitRate(trace: Trace): number | null {
  const calls = trace.spans.filter((span) => span.model !== null);
  if (calls.length === 0) return null;
  return calls.filter((span) => span.model?.cacheHit === true).length / calls.length;
}
