/**
 * Budget breaches accepted in a reviewed change (PRD 9.3).
 *
 * PRD 9.3: "A regression is fixed or explicitly accepted in a reviewed change — the number is never
 * raised to make the build pass." Until this file existed, the only way to get past a breach was
 * to raise the number or stop running the check. An acceptance is the third way the PRD names,
 * made narrow on purpose:
 *
 * - **It names the exact record.** An acceptance matches a breach only when the budget, the
 *   record's commit and the measured value are all identical. A re-run produces a new commit or a
 *   new value, so the acceptance lapses and the next regression fails the build again, instead of
 *   being covered by an old yes.
 * - **It carries its reasons.** Who accepted it, when, the diagnosis, and the decision it follows
 *   from. An acceptance without those is refused as malformed, not treated as a blank cheque.
 * - **The target is untouched.** The breach is still reported as a breach. Only whether it fails
 *   the build changes.
 */

import type { BudgetBreach, LoadRunRecord } from "./measure.js";

export const ACCEPTED_BREACHES_FILE = "accepted-breaches.json";

export interface AcceptedBreach {
  readonly budget: string;
  /** The `commit` of the load-run record the breach was measured in. */
  readonly recordCommit: string;
  /** The measured value, exactly as the record holds it. */
  readonly value: number;
  readonly acceptedBy: string;
  /** `YYYY-MM-DD`. */
  readonly acceptedAt: string;
  /** The diagnosis: which stage, which requests, why. */
  readonly reason: string;
  /** Where the decision is recorded: an ADR, a PHASES entry. */
  readonly decision: string;
}

export class AcceptanceError extends Error {
  public override readonly name = "AcceptanceError";
}

function requireString(entry: Record<string, unknown>, field: string, index: number): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AcceptanceError(`accepted[${String(index)}].${field}: expected a non-empty string`);
  }
  return value;
}

/** Parses the acceptance file, refusing anything incomplete. */
export function parseAcceptances(value: unknown): readonly AcceptedBreach[] {
  const accepted =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).accepted
      : undefined;
  if (!Array.isArray(accepted)) {
    throw new AcceptanceError("expected an object with an `accepted` array");
  }
  return accepted.map((raw: unknown, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new AcceptanceError(`accepted[${String(index)}]: expected an object`);
    }
    const entry = raw as Record<string, unknown>;
    const acceptedAt = requireString(entry, "acceptedAt", index);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(acceptedAt)) {
      throw new AcceptanceError(`accepted[${String(index)}].acceptedAt: expected YYYY-MM-DD`);
    }
    const measured = entry.value;
    if (typeof measured !== "number" || !Number.isFinite(measured)) {
      throw new AcceptanceError(`accepted[${String(index)}].value: expected the measured number`);
    }
    return {
      budget: requireString(entry, "budget", index),
      recordCommit: requireString(entry, "recordCommit", index),
      value: measured,
      acceptedBy: requireString(entry, "acceptedBy", index),
      acceptedAt,
      reason: requireString(entry, "reason", index),
      decision: requireString(entry, "decision", index),
    };
  });
}

export interface BreachReview {
  readonly accepted: readonly { readonly breach: BudgetBreach; readonly by: AcceptedBreach }[];
  readonly unaccepted: readonly BudgetBreach[];
  /** Acceptances that match nothing in this record: lapsed, and worth deleting. */
  readonly lapsed: readonly AcceptedBreach[];
}

/** Which breaches an acceptance covers. A record with no commit can be covered by nothing. */
export function reviewBreaches(
  record: LoadRunRecord,
  breaches: readonly BudgetBreach[],
  acceptances: readonly AcceptedBreach[],
): BreachReview {
  const matches = (breach: BudgetBreach, acceptance: AcceptedBreach): boolean =>
    record.commit !== null &&
    acceptance.budget === breach.id &&
    acceptance.recordCommit === record.commit &&
    acceptance.value === breach.value;

  const accepted: { breach: BudgetBreach; by: AcceptedBreach }[] = [];
  const unaccepted: BudgetBreach[] = [];
  for (const breach of breaches) {
    const by = acceptances.find((acceptance) => matches(breach, acceptance));
    if (by === undefined) unaccepted.push(breach);
    else accepted.push({ breach, by });
  }
  const lapsed = acceptances.filter(
    (acceptance) => !breaches.some((breach) => matches(breach, acceptance)),
  );
  return { accepted, unaccepted, lapsed };
}
