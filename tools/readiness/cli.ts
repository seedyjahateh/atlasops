/**
 * `pnpm readiness` and `pnpm readiness:check`.
 *
 * The run decides, rewrites `docs/promotion-readiness.md`, and writes the proposal when all seven
 * items hold — or removes it when they do not, so that a proposal cannot outlive its verdict.
 *
 * The check is what CI runs. It recomputes both files from the committed artefacts and fails when
 * either differs, so an artefact that changes without the verdict being regenerated breaks the
 * build rather than leaving a verdict that describes different evidence.
 *
 * **One input is not in the files: `dates.started`, the date of the first commit.** The run reads
 * it from git and records it in the proposal. The check takes it from the committed proposal
 * rather than from git, because CI checks out one commit without its history and would read the
 * wrong date — which is recorded provenance, the same way the evaluation records its commit.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  propose,
  PROPOSAL_PATH,
  serialiseProposal,
  type HistoryFacts,
  type Proposal,
} from "./proposal.js";
import { READINESS_PATH, renderReadiness } from "./render.js";
import { decide } from "./verdict.js";
import { directoryView, isRecord, parseJson } from "./view.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function firstCommitDate(): string | null {
  try {
    const dates = execFileSync("git", ["log", "--reverse", "--format=%as"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const first = dates.split("\n")[0]?.trim() ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

function committedStarted(text: string | null): string | null {
  const proposal = parseJson(text);
  const changes = isRecord(proposal) ? proposal.changes : undefined;
  const dates = isRecord(changes) ? changes.dates : undefined;
  const started = isRecord(dates) ? dates.started : undefined;
  return typeof started === "string" ? started : null;
}

function outputs(history: HistoryFacts): { readiness: string; proposal: string | null } {
  const view = directoryView(ROOT);
  const verdict = decide(view);
  const proposal: Proposal | null = verdict.allMet ? propose(view, verdict, history) : null;
  return {
    readiness: renderReadiness(verdict, proposal),
    proposal: proposal === null ? null : serialiseProposal(proposal),
  };
}

function read(path: string): string | null {
  const full = join(ROOT, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function run(): number {
  const { readiness, proposal } = outputs({ started: firstCommitDate() });
  writeFileSync(join(ROOT, READINESS_PATH), readiness);
  const proposalFile = join(ROOT, PROPOSAL_PATH);
  if (proposal === null) {
    rmSync(proposalFile, { force: true });
    process.stdout.write(`readiness: refused. Wrote ${READINESS_PATH}; no proposal exists.\n`);
  } else {
    mkdirSync(dirname(proposalFile), { recursive: true });
    writeFileSync(proposalFile, proposal);
    process.stdout.write(
      `readiness: all seven PRD 12 items met. Wrote ${READINESS_PATH} and ${PROPOSAL_PATH}, for review.\n`,
    );
  }
  return 0;
}

function check(): number {
  const committedProposal = read(PROPOSAL_PATH);
  const { readiness, proposal } = outputs({ started: committedStarted(committedProposal) });
  const problems: string[] = [];
  if (read(READINESS_PATH) !== readiness) {
    problems.push(`${READINESS_PATH} disagrees with the artefacts it is generated from`);
  }
  if (proposal === null && committedProposal !== null) {
    problems.push(`${PROPOSAL_PATH} exists, but the verdict no longer supports a proposal`);
  } else if (proposal !== null && committedProposal !== proposal) {
    problems.push(
      committedProposal === null
        ? `the verdict supports a proposal, but ${PROPOSAL_PATH} does not exist`
        : `${PROPOSAL_PATH} disagrees with the artefacts it is generated from`,
    );
  }
  if (problems.length > 0) {
    process.stderr.write(
      `readiness: ${problems.join("; ")}.\nRun \`pnpm readiness\` and review the diff.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `readiness: ${READINESS_PATH}${proposal === null ? "" : ` and ${PROPOSAL_PATH}`} agree with the artefacts.\n`,
  );
  return 0;
}

process.exitCode = process.argv.includes("--check") ? check() : run();
