/**
 * Judged metrics and their honesty problem (PRD 8.3).
 *
 * "Groundedness and contradiction cannot be computed by string matching, and using a language model
 * as judge introduces a bias that can be mistaken for a quality improvement — particularly when the
 * judge and the generator share a family."
 *
 * The PRD names three controls and all three are mechanisms here rather than practices.
 *
 * **The judge is pinned, and changing the pin invalidates comparison.** `JudgeIdentity` carries the
 * model identifier and the prompt version, it travels on every judged `MetricResult`, and
 * `requireSameJudge` refuses to compare two runs judged differently. A judged number compared
 * across a judge change is not a comparison; it is two different measurements subtracted.
 *
 * **Agreement is reported alongside, not on request.** `judgedMetrics` returns the supported-claim
 * rate, the contradiction rate *and* the judge-human agreement computed on the calibration subset,
 * as one value. There is no way to obtain the first two without the third, because a groundedness
 * score whose judge agrees with humans 60% of the time is not a groundedness score.
 *
 * **Judged metrics never gate alone.** That rule lives in `compare.ts`, where a judged improvement
 * paired with a retrieval regression is reported as a regression — it is a property of the
 * comparison, not of any single metric.
 *
 * What is deliberately absent: any attempt to compute groundedness without a judge. String overlap
 * between an answer and a reference would be cheap, deterministic and wrong, and its wrongness
 * would be invisible because it would still produce a number between zero and one.
 */

import { AtlasOpsError } from "@atlasops/contracts";

import { metricResult, type MetricResult, type PerQueryScore } from "./metric.js";
import type { GroundedAnswerItem } from "./shapes.js";

export interface JudgeIdentity {
  readonly modelId: string;
  /** Changing this invalidates comparison to prior runs exactly as changing the model does. */
  readonly promptVersion: string;
}

export interface Judgement {
  /** Every claim in the answer is supported by the chunks it cites. */
  readonly supported: boolean;
  /** The answer contradicts the supporting material. */
  readonly contradicted: boolean;
}

export interface JudgeRequest {
  readonly itemId: string;
  readonly query: string;
  readonly referenceAnswer: string;
  readonly answerProse: string;
  readonly citedText: readonly string[];
}

export interface Judge {
  readonly identity: JudgeIdentity;
  readonly judge: (request: JudgeRequest) => Promise<Judgement>;
}

export function sameJudge(a: JudgeIdentity, b: JudgeIdentity): boolean {
  return a.modelId === b.modelId && a.promptVersion === b.promptVersion;
}

export function describeJudge(identity: JudgeIdentity): string {
  return `${identity.modelId}@${identity.promptVersion}`;
}

/** Refuses to let two runs judged differently be compared. See the file header. */
export function requireSameJudge(a: JudgeIdentity | null, b: JudgeIdentity | null): void {
  if (a === null && b === null) return;
  if (a === null || b === null || !sameJudge(a, b)) {
    throw new AtlasOpsError(
      "VALIDATION",
      `these runs were judged by ${a === null ? "no judge" : describeJudge(a)} and ` +
        `${b === null ? "no judge" : describeJudge(b)}. PRD 8.3: changing the judge's model or ` +
        `prompt version invalidates comparison to prior runs — subtracting them produces a number ` +
        `that measures the judge change.`,
      "judge.identity",
    );
  }
}

export interface JudgedMetrics {
  readonly supportedClaimRate: MetricResult;
  readonly contradictionRate: MetricResult;
  /**
   * How often the judge agreed with a human on the calibration subset.
   *
   * Returned beside the other two and never separately, because a judged score without it is not
   * interpretable — and separating them is how it stops being reported.
   */
  readonly agreement: MetricResult;
  readonly identity: JudgeIdentity;
  readonly calibrationSize: number;
}

export interface JudgedOutcome {
  readonly itemId: string;
  readonly judgement: Judgement;
}

/**
 * The two judged metrics and the agreement that qualifies them.
 *
 * Agreement is scored per calibration item as the share of the two dimensions the judge and the
 * human agreed on, rather than as exact-match on both. A judge that gets `supported` right and
 * `contradicted` wrong is not equally wrong as one that gets both wrong, and an exact-match rate
 * cannot say so.
 */
export function judgedMetrics(
  items: readonly GroundedAnswerItem[],
  outcomes: readonly JudgedOutcome[],
  identity: JudgeIdentity,
): JudgedMetrics {
  const byId = new Map(outcomes.map((outcome) => [outcome.itemId, outcome.judgement]));

  const supported: PerQueryScore[] = [];
  const contradicted: PerQueryScore[] = [];
  const agreed: PerQueryScore[] = [];

  for (const item of items) {
    const judgement = byId.get(item.id);
    if (judgement === undefined) continue;

    supported.push({ itemId: item.id, value: judgement.supported ? 1 : 0 });
    contradicted.push({ itemId: item.id, value: judgement.contradicted ? 1 : 0 });

    const human = item.humanJudgement;
    if (human === undefined) continue;
    const matches =
      (human.supported === judgement.supported ? 1 : 0) +
      (human.contradicted === judgement.contradicted ? 1 : 0);
    agreed.push({ itemId: item.id, value: matches / 2 });
  }

  if (agreed.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      "no calibration item carried a human judgement, so judge-human agreement cannot be " +
        "reported — and PRD 8.3 requires it alongside every judged metric. A judged score with " +
        "no agreement figure is a number whose reliability nobody has checked.",
      "judge.calibration",
    );
  }

  return {
    supportedClaimRate: metricResult("supported-claim-rate", supported),
    contradictionRate: metricResult("contradiction-rate", contradicted),
    agreement: metricResult("judge-human-agreement", agreed),
    identity,
    calibrationSize: agreed.length,
  };
}

/**
 * A deterministic in-repo judge.
 *
 * It decides support by whether the answer's cited passages contain the reference answer's
 * content words. That is **not a judge** and is not offered as one — it is a stand-in that lets
 * the harness, the agreement calculation and the comparison rules be tested without a model, and
 * nothing it produces says anything about groundedness. A real judge is a `Judge` implementation
 * wired in by an application, with a pinned model and prompt version.
 */
export function fixtureJudge(identity: JudgeIdentity): Judge {
  return {
    identity,
    judge: (request: JudgeRequest): Promise<Judgement> => {
      const evidence = request.citedText.join(" ").toLowerCase();
      const words = request.referenceAnswer
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3);

      const covered = words.filter((word) => evidence.includes(word));
      const supported = words.length > 0 && covered.length / words.length >= 0.5;

      return Promise.resolve({
        supported,
        contradicted: !supported && request.answerProse.length > 0,
      });
    },
  };
}
