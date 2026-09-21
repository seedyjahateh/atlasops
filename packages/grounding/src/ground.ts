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
  type Generator,
  type Sleeper,
  type Usage,
} from "@atlasops/model-gateway";
import type { RetrievalResult } from "@atlasops/retrieval";
import {
  UNPRICED_TABLE,
  canPrice,
  costOf,
  stageBreakdown,
  type PriceTable,
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
}

export interface GroundingRequest {
  readonly requestId: RequestId;
  readonly principal: Principal;
  readonly retrieval: RetrievalResult;
  readonly support?: SupportPolicy;
}

export interface GroundingResult {
  readonly answer: Answer;
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
}

/** The wording a caller may show. Permission-driven cases go through governance's constants. */
function messageFor(answer: Answer, retrieval: RetrievalResult, hadCandidates: boolean): string {
  if (!answer.abstained) return renderProse(answer);

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

  const prompt = assemblePrompt(retrieval.query.normalised, retrieval.candidates);
  const support = assessSupport(retrieval.candidates, request.support ?? SUPPORT_DEFAULTS);

  const verifications: VerificationReport[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let answer: Answer;

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
      const outcome = await generateWithRetry(
        ports.generator,
        { system: prompt.system, user: instruction },
        { sleeper: ports.sleeper },
      );
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

      const report = verifyAnswer({
        answer: parsed,
        prompt,
        candidates: retrieval.candidates,
        journal,
      });
      verifications.push(report);
      candidate = parsed;
      verified = report;
      if (report.ok) break;
      instruction = `${prompt.user}\n\n${correction(report)}`;
    }

    answer =
      verified?.ok === true && candidate !== null
        ? candidate
        : { requestId: request.requestId, abstained: true, reason: "verification-failed" };
  }

  const promptChunks = retrieval.candidates.map((entry) => ({
    chunkId: entry.chunkId,
    sourceVersionId: entry.sourceVersionId,
  }));
  const citedIds = new Set(answer.abstained ? [] : (verifications.at(-1)?.citedChunks ?? []));

  const modelId = ports.generator.modelId;
  // Null rather than zero when the table has no price for this model (ADR 0002). A reader can
  // tell "this cost nothing" from "nobody knows what this cost"; a zero cannot.
  const costUsd = canPrice(prices, modelId)
    ? costOf(prices, modelId, usage.inputTokens, usage.outputTokens).amountUsd
    : null;

  const record = journal.seal({
    promptChunks,
    citedChunks: promptChunks.filter((entry) => citedIds.has(entry.chunkId)),
    models: [modelId],
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    stageTimings: stageBreakdown(retrieval.trace),
    writtenAt: (ports.now ?? (() => new Date().toISOString()))(),
  });

  // The audit is written before the answer is returned, and the answer is withheld if the write
  // fails (PRD 6.6). `releaseAnswer` is the only way out of this function.
  const released = await releaseAnswer(ports.sink, record, answer);

  return {
    answer: released,
    message: messageFor(released, retrieval, retrieval.candidates.length > 0),
    prose: renderProse(released),
    prompt,
    support,
    verifications,
    audit: record,
    attempts,
  };
}
