/**
 * Access-control labels (PRD 6.1).
 *
 * The rule this file exists to make structural: **default is deny.** A label whose readable set is
 * empty grants nothing, and a source whose ACL could not be resolved at all is not a label with an
 * empty set — it is an ingestion failure. Those two cases are different and the type system keeps
 * them apart, because conflating them is the single most common way a governed retrieval system
 * leaks: "unknown" quietly becomes "public" and nothing ever says so.
 */

import { AtlasOpsError } from "./errors.js";
import { parseGroupId, type GroupId } from "./ids.js";
import { rejectUnknownKeys, requireArray, requireLiteral, requireRecord } from "./validate.js";

/**
 * Whether a principal who cannot read a source may learn that it exists.
 *
 * `hidden` changes the wording of an abstention, so that "no results" and "results you may not see"
 * are indistinguishable to the caller (PRD 6.4).
 */
export const EXISTENCE_POLICIES = ["visible", "hidden"] as const;
export type ExistencePolicy = (typeof EXISTENCE_POLICIES)[number];

export interface AclLabel {
  /** Groups permitted to read. Empty means nobody — it never means everybody. */
  readonly readableBy: readonly GroupId[];
  readonly existence: ExistencePolicy;
}

const ACL_FIELDS = ["readableBy", "existence"] as const;

export function parseAclLabel(value: unknown, path: string): AclLabel {
  const record = requireRecord(value, path);
  rejectUnknownKeys(record, ACL_FIELDS, path);
  return {
    readableBy: requireArray(record.readableBy, `${path}.readableBy`).map((entry, index) =>
      parseGroupId(entry, `${path}.readableBy[${String(index)}]`),
    ),
    existence: requireLiteral(record.existence, `${path}.existence`, EXISTENCE_POLICIES),
  };
}

/**
 * The ingestion gate from PRD 6.1: an unresolvable ACL stops the source, loudly.
 *
 * Called at the boundary where a connector hands over a source. It throws rather than returning a
 * default, because every available default is wrong — permissive leaks, restrictive silently drops
 * content and looks like a retrieval bug.
 */
export function requireResolvedAcl(value: unknown, path: string, sourceId: string): AclLabel {
  if (value === null || value === undefined) {
    throw new AtlasOpsError(
      "ACL_UNRESOLVED",
      `${sourceId} arrived with no resolvable ACL. A source with an unknown ACL is not ingested ` +
        `(PRD 6.1): unknown must be a hard error here, not a judgement call at query time.`,
      path,
    );
  }
  return parseAclLabel(value, path);
}

/** Whether a principal holding `groups` may read something carrying `label`. */
export function canRead(label: AclLabel, groups: Iterable<GroupId>): boolean {
  if (label.readableBy.length === 0) return false;
  const held = groups instanceof Set ? groups : new Set(groups);
  return label.readableBy.some((group) => held.has(group));
}

/**
 * The groups a permission pre-filter must compile into the index query (PRD 6.2).
 *
 * Returned as a sorted array so that a cache key built from it is stable regardless of the order
 * group resolution happened to produce.
 */
export function readableByPredicate(groups: Iterable<GroupId>): readonly GroupId[] {
  return [...new Set(groups)].sort();
}
