/**
 * The evaluation runner process.
 *
 * Reads the datasets, runs every arm, writes the artefacts, exits. PRD 8's artefacts are files
 * referenced from a manifest's `evidence` array, so writing files is the whole job; nothing here
 * decides whether a result is good, because that is `compareRuns` against a baseline and a baseline
 * is a deliberate choice somebody makes rather than whatever ran last.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ConfigError,
  artefactsFor,
  readRunnerConfig,
  runEvaluationSuite,
  type DatasetsFile,
} from "./runner.js";

async function main(): Promise<void> {
  const config = readRunnerConfig(process.env, process.argv.slice(2));

  let datasets: DatasetsFile;
  try {
    datasets = JSON.parse(readFileSync(config.datasetsFile, "utf8")) as DatasetsFile;
  } catch (cause) {
    throw new ConfigError(
      `ATLASOPS_DATASETS: could not read ${config.datasetsFile}: ${(cause as Error).message}`,
    );
  }

  process.stdout.write(`atlasops eval-runner: ingesting ${config.corpusRoot}\n`);
  const outcome = await runEvaluationSuite(config, datasets);

  mkdirSync(config.outputDir, { recursive: true });
  for (const artefact of artefactsFor(outcome)) {
    const path = join(config.outputDir, artefact.name);
    writeFileSync(path, artefact.content, "utf8");
    process.stdout.write(`  wrote ${path}\n`);
  }

  process.stdout.write(`\n  corpus snapshot     ${outcome.corpusSnapshot}\n`);
  if (!outcome.snapshotMatchesDatasets) {
    process.stdout.write(
      "  WARNING: the datasets were not labelled against this corpus; the artefacts say so.\n",
    );
  }
  process.stdout.write(`  arms                ${String(outcome.runs.length)}\n\n`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
