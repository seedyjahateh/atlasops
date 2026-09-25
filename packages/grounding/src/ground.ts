/**
 * Grounding: from a retrieved set to a released answer or an abstention (PRD 7.1–7.3, 6.4, 6.6).
 *
 * The order is the argument. Retrieve, decide whether there is enough to answer from, assemble a
 * prompt whose passages cannot address the model as the system does, generate a *structure*, verify
 * it without a model, and only then release — writing the audit first. Prose is derived from the
 * structure at the end. Nothing here ever builds an answer string and attaches citations to it,
 * which is what PRD 7.1 means by citation otherwise being post-hoc rationalisation.
 *
 * **One bounded regeneration, then abstention** (PRD 7.2). The retry is given the verification
 * failures, because a model that cited a passage it was not shown can be told exactly that. It is
 * bounded at one because a verifier-driven retry loop is a way to spend a budget converging on an
 * answer the evidence does not support — and PRD 7.3 is explicit that abstention is a feature, not
 * the failure of one.
 *
 * **The abstention reason is for the audit; the message is for the caller.** They are different
 * fields on purpose. `Abstention.reason` distinguishes `permission-excluded` from `low-support`,
 * which is precisely the distinction PRD 6.4 says an attacker must not be able to make — so the
 * message a caller sees is derived through `governance`'s wording, where "material exists that you
 * may not see" and "nothing was found" are the same bytes for a `hidden` source. A caller that
 * surfaces `reason` to an unprivileged user reopens the oracle, and that is stated here because no
 * type can prevent it.
 *
 * **Generation unavailable degrades to ranked passages** (PRD 9.4): "a retrieval result with no
 * synthesis is still useful; a synthesis with no retrieval is not." A `ModelError` from the
 * generator — the provider down, a rate limit that outlasted its retries, an answer that hit the
 * output limit — ends generation for this request. The caller receives the retrieved passages, in
 * rank order, as citations with no prose, and the answer and the trace are marked degraded. Every
 * passage is one the pre-filter already let this principal read, so the fallback shows nothing
 * the answer path would not have. Anything that is not a `ModelError` still throws: a bug in this
 * package is not an unavailable dependency, and degrading around it would hide it.
 */

import { parseAnswer, renderProse, type Answer, type RequestId } from "@atlasops/contracts";
import {
  abstentionMessage,
  createAuthorizationJournal,
  outcomeFor,
  releaseAnswer,
  type AuditRecord,
  type AuditSink,
  type Principal,
} from "@atlasops/governance";
import {
  generateWithRetry,
  isModelError,
  toModelCall,
  type Generator,
  type Sleeper,
  type Usage,
} from "@atlasops/model-gateway";
import type { RetrievalResult } from "@atlasops/retrieval";
import {
  UNPRICED_TABLE,
  canPrice,
  costOf,
  createTrace,
  mergeStageTimings,
  stageBreakdown,
  systemClock,
  type Clock,
  type PriceTable,
  type StageTiming,
} from "@atlasops/telemetry";

import { assemblePrompt, type AssembledPrompt } from "./prompt.js";
import {
  assessSupport,
  SUPPORT_DEFAULTS,
  type SupportDecision,
  type SupportPolicy,
} from "./support.js";
import { verifyAnswer, type VerificationReport } from "./verify.js";

export interface GroundingPorts {
  readonly generator: Generator;
  readonly sleeper: Sleeper;
  readonly sink: AuditSink;
  /** Defaults to the empty table, where cost is recorded as unknown rather than as zero. */
  readonly prices?: PriceTable;
  /**
   * Wall-clock time, as an ISO instant, for the audit record.
   *
   * A port rather than a call to `Date`, and deliberately not `telemetry`'s `Clock` — that one is
   * monotonic milliseconds for measuring durations, and stamping an audit record with it would
   * record a number that means nothing outside the process. A test supplies a fixed instant; the
   * default is the system clock.
   */
  readonly now?: () => string;
  /**
   * Monotonic milliseconds, for the spans this stage records.
   *
   * Separate from `now` and for a different job: `now` stamps the audit with an instant a reader
   * can compare to a calendar, this measures durations. PRD 9.2 requires a span per stage across
   * the whole request, and until P15a the second half of the request opened none.
   */
  readonly clock?: Clock;
}

export interface GroundingRequest {
  readonly requestId: RequestId;
  readonly principal: Principal;
  readonly retrieval: RetrievalResult;
  readonly support?: SupportPolicy;
  /**
   * Stage timings from earlier in the request, merged into the audit record.
   *
   * Permission resolution happens in the composition root, before retrieval begins, so its span
   * cannot be recorded here. Passing it in is what lets the audit carry the whole request's
   * breakdown rather than the part this function happened to witness.
   */
  readonly priorTimings?: readonly StageTiming[];
}

/** PRD 9.4's degraded modes that arise in this stage. Retrieval's own are on `RetrievalResult`. */
export type GroundingDegradedReason = "generation-unavailable";

/** A retrieved passage returned as-is, when there is no synthesis to cite it from. */
export interface RankedPassage {
  readonly chunkId: RetrievalResult["candidates"][number]["chunkId"];
  readonly sourceVersionId: RetrievalResult["candidates"][number]["sourceVersionId"];
  readonly text: string;
}

export interface GroundingResult {
  readonly answer: Answer;
  /** Empty unless a degraded mode ran. A caller merges this with retrieval's. */
  readonly degraded: readonly GroundingDegradedReason[];
  /**
   * The ranked passages, when generation was unavailable; empty otherwise. These are the citations
   * of a degraded answer — the answer itself is an abstention with no prose.
   */
  readonly passages: readonly RankedPassage[];
  /** What a caller shows a user. Never derived from `Abstention.reason` — see the file header. */
  readonly message: string;
  /** The prose, derived from the structure. Empty on abstention. */
  readonly prose: string;
  readonly prompt: AssembledPrompt;
  readonly support: SupportDecision;
  /** Every verification pass run, in order. Two entries means one regeneration happened. */
  readonly verifications: readonly VerificationReport[];
  readonly audit: AuditRecord;
  readonly attempts: number;
  /**
   * The whole request's stage breakdown, including the audit write the record itself cannot carry.
   *
   * Callers that want timings read this rather than re-deriving them from two traces: doing that by
   * hand is how the P15 load harness came to add the retrieval breakdown to a copy of itself and
   * report every retrieval stage at double its time.
   */
  readonly timings: readonly StageTiming[];
  /**
   * When the first token of the first generation arrived, as a reading of this stage's clock
   * (`ports.clock`), or `null` when no generator streamed one — a stand-in, an abstention before
   * generation, or generation that failed.
   *
   * A clock reading, not a duration, so a caller that timed the request on the same clock gets time
   * to first token by subtraction (PRD 9.3). It is placed by working back from when the call
   * returned, using the adapter's own response time, so retry waits before the successful attempt
   * cannot pull it earlier than it was. **Nothing reached the caller at that moment**: the answer is
   * returned whole, after verification (PRD 7.2). This measures the model, not what a user saw.
   */
  readonly firstTokenAtMs: number | null;
}

/** The wording a caller may show. Permission-driven cases go through governance's constants. */
function messageFor(answer: Answer, retrieval: RetrievalResult, hadCandidates: boolean): string {
  if (!answer.abstained) return renderProse(answer);

  // Only reached with candidates: generation is never attempted without them. The passages are all
  // readable by this principal, so saying they are there discloses nothing (PRD 6.4).
  if (answer.reason === "generation-unavailable") {
    return "An answer could not be written just now. These are the most relevant passages you can read, most relevant first.";
  }

  // Nothing readable was retrieved: the only safe wording is the one that cannot be told apart
  // from "nothing exists", which governance decides from the existence policies (PRD 6.4).
  if (!hadCandidates) {
    return abstentionMessage(outcomeFor(retrieval.existence?.excluded ?? []));
  }

  // Readable material was retrieved and did not support an answer. Saying so discloses nothing
  // about documents the principal cannot read, because they were never in the candidate set.
  return "The available material does not support an answer to this question.";
}

function correction(report: VerificationReport): string {
  const lines = report.failures.map((entry) => `- ${entry.kind}: ${entry.detail}`);
  return [
    "Your previous answer failed verification for the following reasons:",
    ...lines,
    "",
    "Answer again using only the passages above. Cite passages by the exact chunkId shown with",
    'them, and reply exactly {"abstain":true} if they do not support an answer.',
  ].join("\n");
}

function parseModelAnswer(requestId: RequestId, text: string): Answer {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as Record<string, unknown>).abstain === true
  ) {
    return { requestId, abstained: true, reason: "low-support" };
  }
  return parseAnswer({ ...(parsed as Record<string, unknown>), requestId, abstained: false });
}

export async function groundAnswer(
  ports: GroundingPorts,
  request: GroundingRequest,
): Promise<GroundingResult> {
  const { retrieval } = request;
  const prices = ports.prices ?? UNPRICED_TABLE;
  const journal = createAuthorizationJournal({
    requestId: request.requestId,
    principal: request.principal,
    queryHash: retrieval.query.hash,
  });

  // This stage's own trace. Retrieval has always had one; everything after it was dark, so PRD
  // 9.3's verification budget had nothing to aggregate and the report said "not measured".
  const clock = ports.clock ?? systemClock;
  const trace = createTrace(request.requestId, clock);

  const assembly = trace.span("prompt-assembly");
  const prompt = assemblePrompt(retrieval.query.normalised, retrieval.candidates);
  const support = assessSupport(retrieval.candidates, request.support ?? SUPPORT_DEFAULTS);
  assembly.end();

  const verifications: VerificationReport[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let answer: Answer;
  let generationUnavailable = false;
  let firstTokenAtMs: number | null = null;

  if (support.abstain) {
    // PRD 7.3: below the support threshold, or nothing to answer from at all. When nothing was
    // retrieved and material was withheld, the reason records *why* while the message does not.
    const excluded = (retrieval.existence?.excluded ?? []).length > 0;
    answer = {
      requestId: request.requestId,
      abstained: true,
      reason: excluded ? "permission-excluded" : "low-support",
    };
  } else {
    let instruction = prompt.user;
    let verified: VerificationReport | null = null;
    let candidate: Answer | null = null;

    // One generation, and at most one regeneration. See the file header.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      attempts += 1;
      const generation = trace.span("generation");
      let outcome: Awaited<ReturnType<typeof generateWithRetry>>;
      try {
        outcome = await generateWithRetry(
          ports.generator,
          { system: prompt.system, user: instruction },
          { sleeper: ports.sleeper },
        );
      } catch (error) {
        // Decided by the call site, not by `error.capability`: this call is to the generator, so
        // any model failure here is generation failing. The retry loop has already spent its
        // budget on the kinds worth retrying. See the file header.
        if (!isModelError(error)) throw error;
        generation.end({ degraded: true });
        generationUnavailable = true;
        break;
      }
      const returnedAt = clock.now();
      const { firstTokenMs, responseMs } = outcome.result;
      if (firstTokenAtMs === null && firstTokenMs !== undefined && responseMs !== undefined) {
        firstTokenAtMs = returnedAt - (responseMs - firstTokenMs);
      }
      // PRD 9.2: a model-calling span records the model, its tokens, the computed cost, whether it
      // was a cache hit and how many retries it took. A duration alone cannot answer "which stage
      // spent the money", which is the question the aggregate views exist for.
      generation.end({
        model: toModelCall({
          modelId: ports.generator.modelId,
          usage: outcome.result.usage,
          outcome,
          priceTable: prices,
        }),
      });
      usage = {
        inputTokens: usage.inputTokens + outcome.result.usage.inputTokens,
        outputTokens: usage.outputTokens + outcome.result.usage.outputTokens,
      };

      let parsed: Answer;
      try {
        parsed = parseModelAnswer(request.requestId, outcome.result.text);
      } catch (error) {
        // Malformed output is a verification failure like any other: it is an answer that cannot
        // be shown to be supported, which is the only question this stage asks.
        const report: VerificationReport = {
          ok: false,
          failures: [
            {
              kind: "empty-answer",
              detail: `the model's output did not parse as an answer: ${
                error instanceof Error ? error.message : String(error)
              }`,
              segment: null,
              reference: null,
            },
          ],
          citedChunks: [],
        };
        verifications.push(report);
        instruction = `${prompt.user}\n\n${correction(report)}`;
        continue;
      }

      const check = trace.span("verification");
      const report = verifyAnswer({
        answer: parsed,
        prompt,
        candidates: retrieval.candidates,
        journal,
      });
      check.end();
      verifications.push(report);
      candidate = parsed;
      verified = report;
      if (report.ok) break;
      instruction = `${prompt.user}\n\n${correction(report)}`;
    }

    answer = generationUnavailable
      ? { requestId: request.requestId, abstained: true, reason: "generation-unavailable" }
      : verified?.ok === true && candidate !== null
        ? candidate
        : { requestId: request.requestId, abstained: true, reason: "verification-failed" };
  }

  const promptChunks = retrieval.candidates.map((entry) => ({
    chunkId: entry.chunkId,
    sourceVersionId: entry.sourceVersionId,
  }));
  // The degraded answer's citations are the passages it returns: the audit records what the caller
  // was shown, and here that is every candidate, in rank order.
  const passages: RankedPassage[] = generationUnavailable
    ? retrieval.candidates.map((entry) => ({
        chunkId: entry.chunkId,
        sourceVersionId: entry.sourceVersionId,
        text: entry.text,
      }))
    : [];
  const citedIds = new Set(
    generationUnavailable
      ? passages.map((passage) => passage.chunkId)
      : answer.abstained
        ? []
        : (verifications.at(-1)?.citedChunks ?? []),
  );

  const modelId = ports.generator.modelId;
  // Null rather than zero when the table has no price for this model (ADR 0002). A reader can
  // tell "this cost nothing" from "nobody knows what this cost"; a zero cannot.
  const costUsd = canPrice(prices, modelId)
    ? costOf(prices, modelId, usage.inputTokens, usage.outputTokens).amountUsd
    : null;

  const write = trace.span("audit-write");

  const record = journal.seal({
    promptChunks,
    citedChunks: promptChunks.filter((entry) => citedIds.has(entry.chunkId)),
    models: [modelId],
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    // The whole request, not the half this function witnessed. Until P15a this was
    // `stageBreakdown(retrieval.trace)`, so every audit record ever written carried the retrieval
    // stages under the name of the request's timings — a subset nothing in the record identified
    // as one. The audit-write span itself is still open here and is therefore absent: a span
    // cannot record the duration of the write that carries it.
    stageTimings: mergeStageTimings(
      request.priorTimings ?? [],
      stageBreakdown(retrieval.trace),
      stageBreakdown(trace.snapshot()),
    ),
    writtenAt: (ports.now ?? (() => new Date().toISOString()))(),
  });

  // The audit is written before the answer is returned, and the answer is withheld if the write
  // fails (PRD 6.6). `releaseAnswer` is the only way out of this function.
  const released = await releaseAnswer(ports.sink, record, answer);
  write.end();

  return {
    answer: released,
    degraded: generationUnavailable ? ["generation-unavailable"] : [],
    firstTokenAtMs,
    passages,
    message: messageFor(released, retrieval, retrieval.candidates.length > 0),
    prose: renderProse(released),
    prompt,
    support,
    verifications,
    audit: record,
    attempts,
    // Finished here rather than at the snapshot above, so this one includes the audit write.
    timings: mergeStageTimings(
      request.priorTimings ?? [],
      stageBreakdown(retrieval.trace),
      stageBreakdown(trace.finish()),
    ),
  };
}
