/**
 * Sources and source versions (PRD 4.1).
 *
 * The invariant worth the code: **a version identifier must be the hash of the version's bytes.**
 * Checked here rather than trusted, because the whole versioning argument in PRD 4.1 — that
 * re-ingestion is idempotent and rollback is a pointer move — rests on identity being derived from
 * content. A version whose id was allocated rather than derived breaks that quietly: two ingestions
 * of identical bytes produce two versions, and "has this changed?" stops being answerable.
 */

import { parseAclLabel, type AclLabel } from "./acl.js";
import { ValidationError } from "./errors.js";
import { requireContentHash, type ContentHash } from "./hash.js";
import {
  formatSourceVersionId,
  parseSourceId,
  parseSourceVersionId,
  type SourceId,
  type SourceVersionId,
} from "./ids.js";
import {
  rejectUnknownKeys,
  requireInstant,
  requireNullable,
  requireRecord,
  requireString,
} from "./validate.js";

export interface SourceVersion {
  readonly sourceId: SourceId;
  /** Derived from `contentHash`. See the file header. */
  readonly sourceVersionId: SourceVersionId;
  readonly contentHash: ContentHash;
  /** When ingestion observed these bytes. */
  readonly observedAt: string;
  /** When the source itself says the content takes effect, if it says. */
  readonly effectiveDate: string | null;
  /** The upstream revision identifier, when the connector can supply one. */
  readonly upstreamRevision: string | null;
  /** The version this one replaces, forming the audit chain. */
  readonly supersedes: SourceVersionId | null;
  readonly acl: AclLabel;
}

const SOURCE_VERSION_FIELDS = [
  "sourceId",
  "sourceVersionId",
  "contentHash",
  "observedAt",
  "effectiveDate",
  "upstreamRevision",
  "supersedes",
  "acl",
] as const;

export function parseSourceVersion(value: unknown, path = "sourceVersion"): SourceVersion {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, SOURCE_VERSION_FIELDS, path);

  const contentHash = requireContentHash(record.contentHash, `${path}.contentHash`);
  const sourceVersionId = parseSourceVersionId(record.sourceVersionId, `${path}.sourceVersionId`);
  const derived = formatSourceVersionId(contentHash);

  if (sourceVersionId !== derived) {
    throw new ValidationError(
      `${path}.sourceVersionId`,
      `"${sourceVersionId}" is not the identifier for contentHash "${contentHash}" (expected ` +
        `"${derived}"). A version's identity is its content; an allocated identifier makes ` +
        `re-ingestion non-idempotent.`,
    );
  }

  const supersedes = requireNullable(record.supersedes, `${path}.supersedes`, parseSourceVersionId);
  if (supersedes === sourceVersionId) {
    throw new ValidationError(`${path}.supersedes`, "a version cannot supersede itself");
  }

  return {
    sourceId: parseSourceId(record.sourceId, `${path}.sourceId`),
    sourceVersionId,
    contentHash,
    observedAt: requireInstant(record.observedAt, `${path}.observedAt`),
    effectiveDate: requireNullable(record.effectiveDate, `${path}.effectiveDate`, requireInstant),
    upstreamRevision: requireNullable(
      record.upstreamRevision,
      `${path}.upstreamRevision`,
      requireString,
    ),
    supersedes,
    acl: parseAclLabel(record.acl, `${path}.acl`),
  };
}

/**
 * Whether two observations of a source are the same bytes (PRD 4.2).
 *
 * The comparison ingestion makes before deciding to parse anything. It is a hash comparison and
 * nothing else — an unchanged source must cost one comparison, not a parse-and-embed cycle.
 */
export function isUnchanged(previous: SourceVersion | null, observed: ContentHash): boolean {
  return previous !== null && previous.contentHash === observed;
}
