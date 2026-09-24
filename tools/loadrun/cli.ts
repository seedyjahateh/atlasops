/**
 * `pnpm loadrun` and `pnpm loadrun:check`.
 *
 * **The run is a command; the check is what CI runs.** PRD 9.3 wants budgets enforced in CI against
 * the reference profile, and a load run cannot go in CI: against real models it costs money on every
 * push, and against stand-ins it would measure the runner rather than the system. So the run writes
 * a committed record, and CI enforces the budgets against that record.
 *
 * The gap that leaves is real and is stated in the artefact and in `docs/PHASES.md`: a regression
 * surfaces at the next deliberate run rather than at the next push, and between runs the check is
 * only as current as the record's own date. The alternative — no enforcement at all, or a budget
 * quietly checked against numbers nobody produced — is worse, but this is not what the PRD asks for.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelChoice } from "@atlasops/model-gateway";

import { runLoad } from "./harness.js";
import { breachesIn, recordOf, unmeasuredIn, type LoadRunRecord } from "./measure.js";
import { renderLoadReport } from "./render.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const RECORD_PATH = join(ROOT, "docs", "measurements", "load-run.json");

function flag(argv: readonly string[], name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

/** How stale the committed record is, in days, so the check can say it rather than imply currency. */
function ageInDays(record: LoadRunRecord): number {
  const then = Date.parse(record.finishedAt);
  return Number.isNaN(then) ? Number.NaN : (Date.now() - then) / 86_400_000;
}

function check(): number {
  if (!existsSync(RECORD_PATH)) {
    process.stderr.write(
      "loadrun: docs/measurements/load-run.json is missing. PRD 9.3 enforces budgets against the\n" +
        "reference profile, and with no record there is nothing to enforce them against. Run `pnpm loadrun`.\n",
    );
    return 1;
  }

  const record = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as LoadRunRecord;
  const breaches = breachesIn(record);
  const unmeasured = unmeasuredIn(record);
  const age = ageInDays(record);

  process.stdout.write(
    `loadrun: ${String(record.requests)} request(s) on profile "${record.profile.id}" at ` +
      `concurrency ${String(record.profile.concurrency)}, recorded ${record.finishedAt}` +
      `${Number.isNaN(age) ? "" : ` (${String(Math.round(age))} day(s) ago)`}\n` +
      `loadrun: ${String(record.budgets.length - unmeasured.length)} of ` +
      `${String(record.budgets.length)} budgets measured; ${String(unmeasured.length)} not measured\n`,
  );

  for (const row of unmeasured) {
    process.stdout.write(`  not measured  ${row.id}: ${row.unmeasured ?? ""}\n`);
  }

  if (breaches.length > 0) {
    process.stderr.write(`\nloadrun: ${String(breaches.length)} budget(s) exceeded\n\n`);
    for (const breach of breaches) {
      process.stderr.write(
        `  ${breach.id}: ${String(breach.value)} ${breach.unit} against a target of ` +
          `${String(breach.target)} ${breach.unit}\n`,
      );
    }
    process.stderr.write(
      "\nThe target is not raised to make this pass (PRD 9.3). Fix it, or accept the regression in\n" +
        "a reviewed change that says why, with the stage breakdown from the report.\n",
    );
    return 1;
  }

  return 0;
}

async function run(argv: readonly string[]): Promise<number> {
  const concurrency = Number(flag(argv, "concurrency", "4"));
  const repeats = Number(flag(argv, "repeats", "20"));
  const commitFlag = flag(argv, "commit", "");
  // Stand-ins unless asked. The real set spends money, and a forgotten flag must not.
  const models = parseModelChoice(flag(argv, "models", "stand-in"));

  const result = await runLoad({
    corpusRoot: join(ROOT, "examples", "corpus"),
    aclManifest: join(ROOT, "examples", "corpus.acl.json"),
    groupMap: join(ROOT, "examples", "corpus.groups.json"),
    workloadFile: join(ROOT, "examples", "corpus.workload.json"),
    concurrency,
    repeats,
    profileId: `local-${models}-c${String(concurrency)}`,
    models,
    env: process.env,
    retrievalCache: !argv.includes("--no-cache"),
  });

  const record = recordOf(result, commitFlag.length === 0 ? null : commitFlag);

  mkdirSync(dirname(RECORD_PATH), { recursive: true });
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const evidenceDir = join(ROOT, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const reportPath = join(evidenceDir, "cost-and-latency.md");
  writeFileSync(reportPath, renderLoadReport(record), "utf8");

  process.stdout.write(
    `loadrun: ${String(record.requests)} request(s) at concurrency ${String(concurrency)}\n` +
      `loadrun: wrote docs/measurements/load-run.json and evidence/cost-and-latency.md\n`,
  );

  // The run reports a breach; it does not fail on one. Failing here would make the honest response
  // to a slow machine "stop running the load test", and the enforcement point is the check.
  for (const breach of breachesIn(record)) {
    process.stdout.write(
      `loadrun: OVER BUDGET ${breach.id}: ${String(Math.round(breach.value))} ${breach.unit} ` +
        `against ${String(breach.target)} ${breach.unit}\n`,
    );
  }

  return 0;
}

const argv = process.argv.slice(2);
const main = argv.includes("--check") ? Promise.resolve(check()) : run(argv);

main.then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`loadrun: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
