/**
 * What the evidence does not establish, derived from the evidence and never from the model.
 *
 * RAG-03's summary asks the assistant to "surface evidence and uncertainty". The tempting version is
 * to ask the generator how confident it is, and that is exactly the version this rejects: a model's
 * self-reported confidence is a sentence it produced, with no more grounding than any other sentence
 * it produced, and PRD 7 does not let an unsupported claim out. Every statement here is computed
 * from what was retrieved — how many sources, which kinds, how recent — so each one can be checked
 * against the evidence list printed beside it.
 *
 * **Nothing here speaks about material the asker could not see.** Whether anything was withheld is
 * the platform's to say, in `governance`'s wording (PRD 6.4), and the brief relays that message
 * unchanged. A statement like "a relevant postmortem exists that you cannot read" would be the
 * existence oracle arriving through a helpful caveat.
 */

import type { EvidenceKind } from "./metadata.js";

export const UNCERTAINTY_CODES = [
  "single-source",
  "no-postmortem",
  "no-recent-change",
  "stale-evidence",
  "no-evidence",
] as const;
export type UncertaintyCode = (typeof UNCERTAINTY_CODES)[number];

export interface Uncertainty {
  readonly code: UncertaintyCode;
  readonly statement: string;
}

export interface EvidenceSummary {
  readonly sources: readonly string[];
  readonly kinds: readonly EvidenceKind[];
  /** ISO instants of every dated piece of evidence. */
  readonly dates: readonly string[];
  /** Changes found within the window before the incident, if a time was given. */
  readonly recentChanges: number;
  readonly incidentAt: string | null;
  readonly windowHours: number;
}

/** Evidence older than this, relative to the incident, is called out. Unselected, like every number. */
export const STALE_AFTER_DAYS = 90;

export function uncertaintiesOf(summary: EvidenceSummary): readonly Uncertainty[] {
  const found: Uncertainty[] = [];
  const distinct = new Set(summary.sources);

  if (distinct.size === 0) {
    found.push({
      code: "no-evidence",
      statement:
        "Nothing retrieved supports an answer. The brief below is empty rather than guessed.",
    });
    return found;
  }

  if (distinct.size === 1) {
    found.push({
      code: "single-source",
      statement:
        "Everything below comes from one document. A second source that agreed would make it " +
        "more than one author's account.",
    });
  }

  if (!summary.kinds.includes("postmortem")) {
    found.push({
      code: "no-postmortem",
      statement:
        "No postmortem you can read matched. Whether this has happened before is not " +
        "established by what was found.",
    });
  }

  if (summary.incidentAt !== null && summary.recentChanges === 0) {
    found.push({
      code: "no-recent-change",
      statement:
        `No deploy was found in the ${String(summary.windowHours)} hours before the incident. ` +
        `That rules out nothing: the search is bounded by retrieval depth, and a change that was ` +
        `not retrieved is not a change that did not happen.`,
    });
  }

  if (summary.incidentAt !== null && summary.dates.length > 0) {
    const incident = Date.parse(summary.incidentAt);
    const newest = Math.max(...summary.dates.map((date) => Date.parse(date)));
    const days = (incident - newest) / 86_400_000;
    if (days > STALE_AFTER_DAYS) {
      found.push({
        code: "stale-evidence",
        statement:
          `The most recent dated evidence is ${String(Math.round(days))} days older than the ` +
          `incident. Systems change; it may describe one that no longer exists.`,
      });
    }
  }

  return found;
}
