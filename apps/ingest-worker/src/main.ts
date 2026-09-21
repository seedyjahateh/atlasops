/**
 * The ingestion worker process.
 *
 * One crawl, a report, an exit code. It does not loop: scheduling belongs to whatever runs it, and
 * a worker with its own timer is a second scheduler nobody configured. Restartability comes from
 * the corpus rather than from this file — a crawl interrupted halfway leaves the corpus at the
 * version it had, because the index is written before the corpus advances (P6b).
 */

import { ConfigError, createWorker, describeRun, readWorkerConfig } from "./worker.js";

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env, process.argv.slice(2));
  const worker = createWorker(config);

  process.stdout.write(`atlasops ingest-worker: crawling ${config.corpusRoot}\n\n`);
  const report = await worker.run();
  for (const line of describeRun(report)) process.stdout.write(`  ${line}\n`);
  process.stdout.write("\n");

  // Isolation keeps the good sources; it does not make the bad one somebody else's problem.
  process.exit(report.failures.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
