/**
 * Principals and group resolution (PRD 6.1).
 *
 * Groups are resolved **at query time and never cached across requests**. That is not a performance
 * oversight: a cached group set means a revoked membership keeps working until something expires,
 * and "how long after revocation can this person still read the document" becomes a number nobody
 * chose.
 *
 * Resolution has no degraded mode. PRD 9.4 lists one dependency that fails closed rather than
 * degrading, and this is it — every possible fallback is a leak. An empty group set and a failed
 * resolution are therefore different outcomes: empty means "this principal reads nothing", failure
 * means "we do not know what this principal reads" and the request stops.
 */

import {
  AtlasOpsError,
  parseGroupId,
  parsePrincipalId,
  type GroupId,
  type PrincipalId,
} from "@atlasops/contracts";

export interface Principal {
  readonly id: PrincipalId;
  /** Sorted and deduplicated, so the same memberships always produce the same set. */
  readonly groups: readonly GroupId[];
}

export interface GroupResolver {
  /** Throws when membership cannot be determined. Never returns empty to mean "unknown". */
  readonly resolve: (principalId: PrincipalId) => Promise<readonly GroupId[]>;
}

/**
 * Normalised so that group-set identity is a property of the memberships, not of the order a
 * directory happened to return them in. Every cache key and audit record downstream depends on
 * this being stable.
 */
export function normaliseGroups(groups: Iterable<GroupId>): readonly GroupId[] {
  return [...new Set(groups)].sort();
}

export async function resolvePrincipal(
  resolver: GroupResolver,
  principalId: PrincipalId,
): Promise<Principal> {
  let groups: readonly GroupId[];
  try {
    groups = await resolver.resolve(principalId);
  } catch (cause) {
    throw new AtlasOpsError(
      "ACL_UNRESOLVED",
      `group resolution failed for ${principalId}: ${(cause as Error).message}. Permission ` +
        `resolution has no degraded mode (PRD 9.4) — the request stops rather than proceeding with ` +
        `an assumed group set, because every available assumption is a leak.`,
    );
  }

  return { id: principalId, groups: normaliseGroups(groups) };
}

/**
 * The deterministic in-repo fake. Used by every test in this package and every package above it,
 * so nothing downstream needs a directory service to run.
 */
export function staticGroupResolver(
  memberships: Readonly<Record<string, readonly GroupId[]>>,
): GroupResolver {
  return {
    resolve: (principalId: PrincipalId): Promise<readonly GroupId[]> => {
      const groups = memberships[principalId];
      if (groups === undefined) {
        return Promise.reject(new Error(`no membership entry for ${principalId}`));
      }
      return Promise.resolve(groups);
    },
  };
}

/**
 * A membership map read from data, for a corpus that ships its principals beside its zones.
 *
 * Validated rather than cast. A membership file decides who reads what, so a malformed one stops
 * the process rather than resolving to an empty group set — empty means "reads nothing", and a
 * principal who silently reads nothing is indistinguishable from a working system with an empty
 * corpus. Identifiers go through the `contracts` parsers, so a typo is a startup error rather than
 * a permission that never matches anything.
 */
export function parseGroupMap(
  value: unknown,
  where = "groups",
): Readonly<Record<string, readonly GroupId[]>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AtlasOpsError("VALIDATION", `${where} must be an object`, where);
  }

  // `$`-prefixed keys are comments in the JSON files this parses, the same convention layers.json
  // uses. A comment is not a principal.
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([principalId]) => !principalId.startsWith("$"),
  );
  if (entries.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${where} names no principal. Every request would then fail to resolve, which is safe and ` +
        `indistinguishable from a broken directory.`,
      where,
    );
  }

  const map: Record<string, readonly GroupId[]> = {};
  for (const [principalId, groups] of entries) {
    const at = `${where}.${principalId}`;
    parsePrincipalId(principalId, at);
    if (!Array.isArray(groups)) {
      throw new AtlasOpsError("VALIDATION", `${at} must be an array of group identifiers`, at);
    }
    map[principalId] = normaliseGroups(
      groups.map((group, index) => {
        if (typeof group !== "string") {
          throw new AtlasOpsError("VALIDATION", `${at}[${String(index)}] must be a string`, at);
        }
        return parseGroupId(group, `${at}[${String(index)}]`);
      }),
    );
  }

  return map;
}

/** A resolver that always fails, for exercising the fail-closed path. */
export function unavailableGroupResolver(reason = "directory unavailable"): GroupResolver {
  return {
    resolve: (): Promise<readonly GroupId[]> => Promise.reject(new Error(reason)),
  };
}
