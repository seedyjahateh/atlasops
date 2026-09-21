/**
 * The verification pass (PRD 7.2).
 *
 * "The pass is cheap, deterministic, and non-model-based, which is what makes it trustworthy — a
 * verifier that is itself a language model inherits the failure mode it is meant to catch."
 *
 * Nothing in this file reads a passage for meaning. It checks identifiers, membership, permission
 * and offsets, all of which are decidable. That is also its limit, and the limit is the point: this
 * is PRD 7.2's *structural floor*, not a claim that the answer is true. Scored entailment over
 * decomposed claims is RAG-15's subject, and a verifier that tried to be one here would have to ask
 * a model whether a model's answer was supported, which is the same model deciding its own case.
 *
 * Spans are checked against **the text the model was shown**, not against the stored chunk. Prompt
 * assembly neutralises delimiter sequences inside a passage, so the two can differ by a few
 * characters exactly when a document talks about this system. Verifying against the stored chunk
 * would then reject a correct citation, or worse accept one that points at different words; the
 * block text is what the claim was made from and is what a renderer must resolve the span against.
 */

import type { AclLabel, Answer, ChunkId, Reference } from "@atlasops/contracts";
import type { AuthorizationJournal } from "@atlasops/governance";
import type { FusedCandidate } from "@atlasops/retrieval";

import type { AssembledPrompt } from "./prompt.js";

export type VerificationFailureKind =
  /** A claim segment carried no reference. Schema-level, re-checked here at the boundary. */
  | "unsupported-claim"
  /** A reference named a chunk that was not in the retrieved set for this request. */
  | "uncited-chunk"
  /** A reference named a chunk this principal may not read. */
  | "unreadable-chunk"
  /** The reference's version does not match the chunk's. It cites a document that does not exist. */
  | "version-mismatch"
  /** The cited span falls outside the passage the model was shown. */
  | "span-out-of-range"
  /** The model produced nothing to verify. */
  | "empty-answer";

export interface VerificationFailure {
  readonly kind: VerificationFailureKind;
  readonly detail: string;
  readonly segment: number | null;
  readonly reference: number | null;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly failures: readonly VerificationFailure[];
  /** Every chunk the answer cited, whether or not it verified. For the audit record (PRD 6.6). */
  readonly citedChunks: readonly ChunkId[];
}

export interface VerificationInput {
  readonly answer: Answer;
  /** What the model was shown. Spans are offsets into these blocks. */
  readonly prompt: AssembledPrompt;
  /** The retrieved set for this request, carrying the labels PRD 7.2's readability check needs. */
  readonly candidates: readonly FusedCandidate[];
  /**
   * The journal, so the readability check is recorded rather than merely performed.
   *
   * PRD 6.6 requires an audit record for every authorisation decision, and this pass makes one per
   * cited chunk. Passing the journal rather than a predicate is what makes that unavoidable.
   */
  readonly journal: AuthorizationJournal;
}

function failure(
  kind: VerificationFailureKind,
  detail: string,
  segment: number | null = null,
  reference: number | null = null,
): VerificationFailure {
  return { kind, detail, segment, reference };
}

export function verifyAnswer(input: VerificationInput): VerificationReport {
  const { answer } = input;

  if (answer.abstained) {
    // An abstention is not an answer to verify. It is already the failure mode, and running the
    // pass over it would report "no claims" as a defect.
    return { ok: true, failures: [], citedChunks: [] };
  }

  const byId = new Map<string, { label: AclLabel; sourceVersionId: string }>(
    input.candidates.map((candidate) => [
      candidate.chunkId,
      { label: candidate.acl, sourceVersionId: candidate.sourceVersionId },
    ]),
  );
  const shown = new Map(input.prompt.blocks.map((block) => [block.chunkId, block.text]));

  const failures: VerificationFailure[] = [];
  const cited: ChunkId[] = [];

  if (answer.segments.length === 0) {
    failures.push(failure("empty-answer", "the answer carried no claim segments"));
  }

  answer.segments.forEach((segment, segmentIndex) => {
    if (segment.references.length === 0) {
      failures.push(
        failure("unsupported-claim", `segment ${String(segmentIndex)} cites nothing`, segmentIndex),
      );
      return;
    }

    segment.references.forEach((reference: Reference, referenceIndex) => {
      const chunkId = reference.chunkId as string;
      cited.push(reference.chunkId);

      const candidate = byId.get(chunkId);
      if (candidate === undefined) {
        // The failure this catches is the one an injection produces: a model persuaded to name a
        // document it was never shown.
        failures.push(
          failure(
            "uncited-chunk",
            `${chunkId} was not in the retrieved set for this request`,
            segmentIndex,
            referenceIndex,
          ),
        );
        return;
      }

      // Recorded as it is decided. Every candidate here is readable by construction — the index
      // pre-filter saw to that — so this check is defence in depth, and it is also the thing that
      // would catch a candidate set assembled by some future path that skipped the pre-filter.
      if (!input.journal.authorize(chunkId, candidate.label)) {
        failures.push(
          failure(
            "unreadable-chunk",
            `${chunkId} is not readable by this principal`,
            segmentIndex,
            referenceIndex,
          ),
        );
        return;
      }

      if (reference.sourceVersionId !== candidate.sourceVersionId) {
        failures.push(
          failure(
            "version-mismatch",
            `${chunkId} belongs to ${candidate.sourceVersionId}, not ` + reference.sourceVersionId,
            segmentIndex,
            referenceIndex,
          ),
        );
        return;
      }

      const text = shown.get(chunkId) ?? "";
      if (reference.span.end > text.length) {
        failures.push(
          failure(
            "span-out-of-range",
            `span ${String(reference.span.start)}–${String(reference.span.end)} falls outside a ` +
              `passage of ${String(text.length)} characters`,
            segmentIndex,
            referenceIndex,
          ),
        );
      }
    });
  });

  return { ok: failures.length === 0, failures, citedChunks: [...new Set(cited)] };
}

/** The passage a reference points at, for rendering a citation. */
export function citedText(prompt: AssembledPrompt, reference: Reference): string {
  const block = prompt.blocks.find((entry) => entry.chunkId === (reference.chunkId as string));
  return block === undefined ? "" : block.text.slice(reference.span.start, reference.span.end);
}
