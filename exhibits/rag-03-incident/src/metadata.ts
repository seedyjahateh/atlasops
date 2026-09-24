/**
 * What kind of evidence a document is, and when it was true.
 *
 * An incident brief is only as useful as its sense of time and provenance. "The runbook says roll
 * back" and "a postmortem from last month says the same symptom came from a deploy" and "payments
 * shipped two hours ago" are three different kinds of evidence, and a responder weighs them
 * differently. So every piece of evidence is classified by kind, and the ones that carry a date —
 * deploys and postmortems — carry it into the brief.
 *
 * **The kind comes from where the document lives, not from what it says.** A document that
 * described itself as a postmortem would be classifying itself, and a retrieved passage is data,
 * never instruction (PRD 6.5). The directory is set by whoever filed it.
 *
 * **The date comes from the document's header, and a missing date is null, not now.** A deploy with
 * no parseable timestamp is a deploy whose timing is unknown; dating it to the moment it was read
 * would put it inside every incident window.
 */

import type { SourceId } from "@atlasops/contracts";

export const EVIDENCE_KINDS = ["runbook", "postmortem", "deploy", "dashboard"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const DIRECTORY_KIND: Readonly<Record<string, EvidenceKind>> = {
  runbooks: "runbook",
  postmortems: "postmortem",
  deploys: "deploy",
  dashboards: "dashboard",
};

/**
 * The kind of evidence a source is, from the directory it was filed in.
 *
 * Source identifiers are derived from paths by the filesystem connector — `runbooks/x.md` becomes
 * `src_runbooks--x.md` — so the first segment is the directory. An unrecognised directory is null
 * rather than a guess: the brief then reports the evidence without a kind instead of mislabelling it.
 */
export function kindOf(sourceId: SourceId | string): EvidenceKind | null {
  const withoutPrefix = sourceId.startsWith("src_") ? sourceId.slice(4) : sourceId;
  const directory = withoutPrefix.split("--")[0] ?? "";
  return DIRECTORY_KIND[directory] ?? null;
}

/** A readable path for a source, for display only. The identifier remains the citation. */
export function displayPathOf(sourceId: SourceId | string): string {
  const withoutPrefix = sourceId.startsWith("src_") ? sourceId.slice(4) : sourceId;
  return withoutPrefix.split("--").join("/");
}

export interface DocumentHeader {
  /** Every `Key: value` line before the first `##` section, keyed in lower case. */
  readonly fields: Readonly<Record<string, string>>;
  /** From `Deployed:` or `Date:`, when one parses. Null otherwise — never the current time. */
  readonly recordedAt: string | null;
}

export function headerOf(text: string): DocumentHeader {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) break;
    const match = /^([A-Za-z][A-Za-z ]*):\s*(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields[match[1].toLowerCase()] = match[2].trim();
    }
  }

  const raw = fields.deployed ?? fields.date;
  const parsed = raw === undefined ? Number.NaN : Date.parse(raw);
  return {
    fields,
    recordedAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
  };
}
