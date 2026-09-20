/**
 * Abstention wording (PRD 6.4).
 *
 * The requirement is unusual and worth restating: when a query would have been answerable from
 * sources the principal cannot read, the wording depends on the source's `existence` policy — and
 * for `hidden` sources the wording must be **byte-identical** to the wording used when nothing
 * relevant was found at all.
 *
 * Otherwise the refusal becomes an oracle. An attacker who can tell "nothing exists" from "you may
 * not see it" enumerates the corpus by the shape of the refusal, without ever reading a document.
 * That is why these strings are constants in one file with a test asserting the identity, rather
 * than two call sites that happen to say the same thing today.
 *
 * `visible` is different on purpose: stating that relevant material exists and is not accessible is
 * useful, and is itself an access-control decision somebody made deliberately when they labelled
 * the source.
 */

import type { ExistencePolicy } from "@atlasops/contracts";

export const ABSTENTION_OUTCOMES = [
  /** Retrieval found nothing relevant. */
  "nothing-relevant",
  /** Relevant material exists in `hidden` sources the principal cannot read. */
  "excluded-hidden",
  /** Relevant material exists in `visible` sources the principal cannot read. */
  "excluded-visible",
] as const;

export type AbstentionOutcome = (typeof ABSTENTION_OUTCOMES)[number];

/**
 * One string, used for both `nothing-relevant` and `excluded-hidden`.
 *
 * Declared once and referenced twice rather than written twice: two identical literals drift the
 * first time somebody improves the wording of one of them, and the drift reopens the oracle
 * silently.
 */
const INDISTINGUISHABLE = "No relevant material was found for this query.";

const EXCLUDED_VISIBLE =
  "Relevant material exists for this query, but it is not accessible with your current access.";

export function abstentionMessage(outcome: AbstentionOutcome): string {
  switch (outcome) {
    case "nothing-relevant":
    case "excluded-hidden":
      return INDISTINGUISHABLE;
    case "excluded-visible":
      return EXCLUDED_VISIBLE;
  }
}

/**
 * Which outcome applies, given what permission filtering removed.
 *
 * `hidden` wins when both kinds were excluded. Revealing the existence of visible material while
 * hidden material was also excluded would still narrow the attacker's search, and the conservative
 * answer costs a legitimate user only a less specific message.
 */
export function outcomeFor(excluded: readonly ExistencePolicy[]): AbstentionOutcome {
  if (excluded.length === 0) return "nothing-relevant";
  if (excluded.includes("hidden")) return "excluded-hidden";
  return "excluded-visible";
}
