/**
 * The answer contract (PRD 7.1).
 *
 * An answer is a structured object, not a string, and the ordering is the whole argument: if the
 * model produces prose and citations are attached afterwards, citation is a post-hoc
 * rationalisation and the binding is unverifiable. Because the structure is primary here, **an
 * unsupported claim is a schema violation** — `parseAnswer` rejects a claim segment with no
 * references, so the failure is mechanical rather than a matter of review.
 *
 * `renderProse` derives the prose from the structure. Nothing in this system constructs an answer
 * string by any other route; that is what keeps the rendered text and the citations in step.
 */

import { ValidationError } from "./errors.js";
import {
  parseChunkId,
  parseRequestId,
  parseSourceVersionId,
  type ChunkId,
  type RequestId,
  type SourceVersionId,
} from "./ids.js";
import {
  rejectUnknownKeys,
  requireLiteral,
  requireNonEmptyArray,
  requireNonNegativeInteger,
  requireRecord,
  requireString,
} from "./validate.js";

/** A half-open character range within a chunk's text. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** What supports one claim: a chunk, its version, and the span within it that says so. */
export interface Reference {
  readonly chunkId: ChunkId;
  readonly sourceVersionId: SourceVersionId;
  readonly span: Span;
}

export interface ClaimSegment {
  readonly text: string;
  /** Never empty. Enforced by `parseAnswer` — see the file header. */
  readonly references: readonly Reference[];
}

/** Why the system declined to answer (PRD 7.3). Abstention is a feature and is evaluated as one. */
export const ABSTENTION_REASONS = [
  /** Reranked top candidates fell below the support threshold. */
  "low-support",
  /** The verification pass failed twice. */
  "verification-failed",
  /** The only relevant material was excluded by permissions. */
  "permission-excluded",
] as const;

export type AbstentionReason = (typeof ABSTENTION_REASONS)[number];

export interface GroundedAnswer {
  readonly requestId: RequestId;
  readonly abstained: false;
  readonly segments: readonly ClaimSegment[];
}

export interface Abstention {
  readonly requestId: RequestId;
  readonly abstained: true;
  readonly reason: AbstentionReason;
}

export type Answer = GroundedAnswer | Abstention;

const SPAN_FIELDS = ["start", "end"] as const;
const REFERENCE_FIELDS = ["chunkId", "sourceVersionId", "span"] as const;
const SEGMENT_FIELDS = ["text", "references"] as const;
const GROUNDED_FIELDS = ["requestId", "abstained", "segments"] as const;
const ABSTENTION_FIELDS = ["requestId", "abstained", "reason"] as const;

function parseSpan(value: unknown, path: string): Span {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, SPAN_FIELDS, path);
  const start = requireNonNegativeInteger(record.start, `${path}.start`);
  const end = requireNonNegativeInteger(record.end, `${path}.end`);
  if (end <= start) {
    throw new ValidationError(
      `${path}.end`,
      `expected end (${String(end)}) to be greater than start (${String(start)}); a zero-width ` +
        `citation span points at nothing`,
    );
  }
  return { start, end };
}

function parseReference(value: unknown, path: string): Reference {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, REFERENCE_FIELDS, path);
  return {
    chunkId: parseChunkId(record.chunkId, `${path}.chunkId`),
    sourceVersionId: parseSourceVersionId(record.sourceVersionId, `${path}.sourceVersionId`),
    span: parseSpan(record.span, `${path}.span`),
  };
}

function parseSegment(value: unknown, path: string): ClaimSegment {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, SEGMENT_FIELDS, path);

  let references: unknown[];
  try {
    references = requireNonEmptyArray(record.references, `${path}.references`);
  } catch {
    throw new ValidationError(
      `${path}.references`,
      "a claim segment must carry at least one supporting reference. An unsupported claim is a " +
        "schema violation here, not a quality problem to be reviewed later (PRD 7.1).",
    );
  }

  return {
    text: requireString(record.text, `${path}.text`),
    references: references.map((entry, index) =>
      parseReference(entry, `${path}.references[${String(index)}]`),
    ),
  };
}

export function parseAnswer(value: unknown, path = "answer"): Answer {
  const record = requireRecord(value, path);
  const abstained = record.abstained;

  if (abstained === true) {
    rejectUnknownKeys(record, ABSTENTION_FIELDS, path);
    return {
      requestId: parseRequestId(record.requestId, `${path}.requestId`),
      abstained: true,
      reason: requireLiteral(record.reason, `${path}.reason`, ABSTENTION_REASONS),
    };
  }

  if (abstained !== false) {
    throw new ValidationError(`${path}.abstained`, "expected the literal true or false");
  }

  rejectUnknownKeys(record, GROUNDED_FIELDS, path);
  const segments = requireNonEmptyArray(record.segments, `${path}.segments`);

  return {
    requestId: parseRequestId(record.requestId, `${path}.requestId`),
    abstained: false,
    segments: segments.map((entry, index) =>
      parseSegment(entry, `${path}.segments[${String(index)}]`),
    ),
  };
}

/**
 * The prose a reader sees, derived from the structure.
 *
 * Deliberately dull. Every interesting rendering decision — numbering citations, grouping by
 * source, rendering heading paths — belongs to a presentation layer that can see the corpus. What
 * matters here is that there is exactly one function turning structure into text, so prose and
 * citations cannot drift apart.
 */
export function renderProse(answer: Answer): string {
  if (answer.abstained) return "";
  return answer.segments.map((segment) => segment.text).join(" ");
}

/** Every chunk an answer relies on, in first-cited order, without duplicates. */
export function citedChunkIds(answer: Answer): readonly ChunkId[] {
  if (answer.abstained) return [];
  const seen = new Set<ChunkId>();
  for (const segment of answer.segments) {
    for (const reference of segment.references) seen.add(reference.chunkId);
  }
  return [...seen];
}
