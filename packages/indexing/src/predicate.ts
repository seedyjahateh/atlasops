/**
 * Permission predicate compilation (PRD 6.2).
 *
 * **The compiled predicate is data, not a closure**, and that is the decision this file exists to
 * make. A `(row) => boolean` would be easier to write and impossible to hold to account: a closure
 * can be invoked anywhere — before candidate generation, after it, after reranking — and no test,
 * review or type can tell a pre-filter from a post-filter that happens to run early. A declarative
 * filter cannot be applied by accident. An adapter has to compile it into its own access path, and
 * the shape of that access path is then a reviewable property of the adapter rather than a promise
 * in a comment.
 *
 * The second half of the mechanism is in `partition.ts`: the adapters store rows in per-group
 * posting lists, so "apply the filter" and "decide which rows exist" are the same operation. A row
 * the principal may not read is not filtered out — it is never reached.
 *
 * An empty group set compiles to `deny-all`, not to an absent filter. PRD 6.1: empty means "reads
 * nothing" and never "reads everything", and the two must not share a representation.
 */

import { readableByPredicate, type ContentHash, type GroupId } from "@atlasops/contracts";
import { groupSetHash, type Principal } from "@atlasops/governance";

export type PermissionFilter =
  /** The row's ACL must list at least one of these groups. */
  | { readonly op: "any-group"; readonly groups: readonly GroupId[] }
  /** Matches nothing. A principal with no groups reads nothing (PRD 6.1). */
  | { readonly op: "deny-all" };

export interface CompiledPredicate {
  /** Sorted and deduplicated. This is what PRD 6.6's audit record stores. */
  readonly groups: readonly GroupId[];
  readonly groupSetHash: ContentHash;
  readonly filter: PermissionFilter;
}

export function compilePredicate(principal: Principal): CompiledPredicate {
  const groups = readableByPredicate(principal.groups);
  return {
    groups,
    groupSetHash: groupSetHash(groups),
    filter: groups.length === 0 ? { op: "deny-all" } : { op: "any-group", groups },
  };
}

/**
 * The predicate as a line, for the audit record and for a failure message.
 *
 * PRD 6.6 requires the compiled predicate to be part of every audit record. Rendering it here means
 * the thing recorded and the thing applied come from one representation, rather than a log line
 * that describes what somebody believes the filter does.
 */
export function renderPredicate(filter: PermissionFilter): string {
  return filter.op === "deny-all" ? "deny-all" : `any-group(${filter.groups.join(", ")})`;
}

/** The groups a partitioned store must visit for this filter. Empty for `deny-all`. */
export function groupsToVisit(filter: PermissionFilter): readonly GroupId[] {
  return filter.op === "deny-all" ? [] : filter.groups;
}
