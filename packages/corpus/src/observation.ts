/**
 * What a connector reports, and the version that follows from it (PRD 4.1, 4.2).
 *
 * A `SourceObservation` is the cheapest thing a connector can produce: an identifier, the content
 * hash of the bytes it currently holds, when it looked, and the access label it resolved. It is
 * deliberately *not* the bytes. PRD 4.2 requires an unchanged source to cost one hash comparison
 * rather than a parse-and-embed cycle, and that is only achievable if the decision to fetch content
 * is made from the observation alone.
 *
 * `acl` is typed `unknown` on purpose. A connector that could not resolve an access label must not
 * be able to express that as an omitted field that quietly reads as "no restrictions" — it arrives
 * here unvalidated and `requireResolvedAcl` turns the unresolved case into a loud failure (PRD 6.1)
 * at the one boundary where a source enters the system.
 */

import {
  formatSourceVersionId,
  parseSourceVersion,
  requireContentHash,
  requireResolvedAcl,
  type AclLabel,
  type ContentHash,
  type SourceId,
  type SourceVersion,
  type SourceVersionId,
} from "@atlasops/contracts";

export interface SourceObservation {
  readonly sourceId: SourceId;
  /** The hash of the bytes the connector currently holds. */
  readonly contentHash: ContentHash;
  /** When the connector looked. */
  readonly observedAt: string;
  /** When the source itself says the content takes effect, if it says. */
  readonly effectiveDate?: string | null;
  /** The upstream revision identifier, when the connector can supply one. */
  readonly upstreamRevision?: string | null;
  /** Unvalidated: an unresolvable label must fail, not default. See the file header. */
  readonly acl: unknown;
}

/**
 * The version identifier these bytes have, without building or validating a record.
 *
 * This is the comparison PRD 4.2 budgets for. It is a hash reformat and nothing else, so deciding
 * that a source is unchanged costs the same whether the document is a paragraph or a thousand
 * pages.
 */
export function observedVersionId(observation: SourceObservation): SourceVersionId {
  return formatSourceVersionId(
    requireContentHash(observation.contentHash, "observation.contentHash"),
  );
}

/** The access label an observation carries, or a loud failure if it carries none (PRD 6.1). */
export function observedAcl(observation: SourceObservation): AclLabel {
  return requireResolvedAcl(observation.acl, "observation.acl", observation.sourceId);
}

/**
 * The immutable record for an observation.
 *
 * Built and then round-tripped through `parseSourceVersion` rather than constructed and trusted,
 * so the invariant that a version's identity is its content is checked on the way in rather than
 * assumed because this file happens to derive it correctly today.
 */
export function versionFrom(
  observation: SourceObservation,
  supersedes: SourceVersionId | null,
): SourceVersion {
  const contentHash = requireContentHash(observation.contentHash, "observation.contentHash");

  return parseSourceVersion(
    {
      sourceId: observation.sourceId,
      sourceVersionId: formatSourceVersionId(contentHash),
      contentHash,
      observedAt: observation.observedAt,
      effectiveDate: observation.effectiveDate ?? null,
      upstreamRevision: observation.upstreamRevision ?? null,
      supersedes,
      acl: observedAcl(observation),
    },
    "observation",
  );
}
