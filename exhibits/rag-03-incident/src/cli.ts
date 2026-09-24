/**
 * `pnpm exhibit:rag-03 -- --principal prn_oncall --at 2026-09-20T15:10:00Z "checkout 502 errors"`
 *
 * Prints a brief: evidence grouped by kind, recent changes before the incident, and what the
 * evidence does not establish. There is no flag that acts on anything, because there is nothing in
 * the brief that could be acted on.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createIncidentAssistant } from "./assistant.js";
import { evaluateIncident, loadIncidentDataset } from "./evaluate.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "..", "fixtures");

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--evaluate")) {
    const assistant = await createIncidentAssistant({
      corpusRoot: join(FIXTURES, "corpus"),
      aclManifest: join(FIXTURES, "acl.json"),
      groupMap: join(FIXTURES, "groups.json"),
    });
    const dataset = loadIncidentDataset(join(FIXTURES, "dataset.json"));
    const scores = await evaluateIncident(dataset, assistant);
    process.stdout.write(
      `rag-03: ${dataset.id}@${dataset.version}, ${String(scores.items)} scorable item(s)\n` +
        `  recall@5  ${scores.recallAt5.toFixed(4)}\n` +
        `  MRR       ${scores.mrr.toFixed(4)}\n` +
        `  unscorable (no readable relevant section): ${scores.unscorable.join(", ") || "none"}\n\n` +
        "These numbers measure a stand-in embedder over a seven-document fixture labelled by its\n" +
        "author. They show the evaluation runs; they say nothing about retrieval quality.\n",
    );
    return 0;
  }

  const principal = flag(argv, "principal") ?? "prn_oncall";
  const incidentAt = flag(argv, "at");
  const valued = new Set(["--principal", "--at"]);
  const question = argv
    .filter((arg, index) => !arg.startsWith("--") && !valued.has(argv[index - 1] ?? ""))
    .join(" ");

  if (question.length === 0) {
    process.stderr.write(
      'rag-03: ask something, e.g. --principal prn_oncall --at 2026-09-20T15:10:00Z "checkout 502 errors"\n',
    );
    return 1;
  }

  const assistant = await createIncidentAssistant({
    corpusRoot: join(FIXTURES, "corpus"),
    aclManifest: join(FIXTURES, "acl.json"),
    groupMap: join(FIXTURES, "groups.json"),
  });

  const brief = await assistant.investigate(principal, question, { incidentAt });

  process.stdout.write(`Question: ${brief.question}\n\nEvidence\n`);
  for (const item of brief.evidence) {
    process.stdout.write(
      `  [${item.kind ?? "unclassified"}] ${item.path} — ${item.section}` +
        `${item.recordedAt === null ? "" : ` (${item.recordedAt.slice(0, 10)})`}\n`,
    );
  }

  process.stdout.write("\nRecent changes\n");
  if (brief.recentChanges.length === 0) process.stdout.write("  none found\n");
  for (const change of brief.recentChanges) {
    process.stdout.write(
      `  ${change.path} (${change.service ?? "unknown service"}), ${String(change.hoursBefore)}h before\n`,
    );
  }

  process.stdout.write("\nWhat this does not establish\n");
  if (brief.uncertainty.length === 0) process.stdout.write("  nothing flagged\n");
  for (const entry of brief.uncertainty) process.stdout.write(`  - ${entry.statement}\n`);

  process.stdout.write(
    "\nEvery step above is quoted evidence for a person to judge. This assistant takes no action.\n",
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`rag-03: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
