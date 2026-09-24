/**
 * `pnpm datasets:hash` and `pnpm datasets:check`.
 *
 * The hash pass writes each dataset's content hash into the file. It exists because a dataset's
 * hash is derived from its items, so the first version of a hand-written file cannot declare one —
 * and a file that never declares one has PRD 8.1's re-labelling check permanently disabled while
 * looking exactly like a file that passes it.
 *
 * The check pass runs in `pnpm verify` and does two separate jobs: it loads every dataset through
 * `loadDataset`, which recomputes the hash and refuses a mismatch, and it runs the corpus checks in
 * `validate.ts`, which `loadDataset` cannot do because it has never seen a corpus.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseGroupMap } from "@atlasops/governance";
import { datasetContentHash, loadDataset } from "@atlasops/evalkit";

import { checkDatasets, type DatasetUnderCheck, type InventoryRef } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(here, "..", "..");
const DATASETS_PATH = join(REPOSITORY_ROOT, "examples", "corpus.datasets.json");
const INVENTORY_PATH = join(REPOSITORY_ROOT, "examples", "corpus.inventory.json");
const GROUPS_PATH = join(REPOSITORY_ROOT, "examples", "corpus.groups.json");

/** The four keys the runner reads, in the order a reader of the file meets them. */
const KINDS = ["relevance", "groundedAnswers", "abstention", "permissionProbe"] as const;

interface RawDataset {
  readonly id: string;
  readonly version: string;
  readonly kind: string;
  readonly corpusSnapshot: string;
  contentHash?: string;
  readonly items: readonly Record<string, unknown>[];
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** What each item claims the principal should and must not receive. */
function labelled(kind: string, items: readonly Record<string, unknown>[]) {
  return items.map((item) => {
    const wanted =
      kind === "relevance"
        ? Object.entries((item.judgments ?? {}) as Record<string, number>)
            // A judgment of zero is an explicit "not relevant", not a request to retrieve it.
            .filter(([, grade]) => grade > 0)
            .map(([chunkId]) => chunkId)
        : ((item.supportingChunks ?? []) as readonly string[]);

    return {
      id: String(item.id),
      principal: String(item.principal),
      wanted,
      forbidden: (item.forbiddenChunks ?? []) as readonly string[],
    };
  });
}

/** `--file <path>`, for writing hashes into a dataset file other than the corpus one. */
function pathFrom(argv: readonly string[]): string {
  const at = argv.indexOf("--file");
  return at === -1 ? DATASETS_PATH : resolve(REPOSITORY_ROOT, argv[at + 1] ?? DATASETS_PATH);
}

function main(argv: readonly string[]): number {
  const datasetsPath = pathFrom(argv);
  const file = read(datasetsPath) as Record<string, unknown>;
  const inventory = read(INVENTORY_PATH) as InventoryRef;
  const memberships = parseGroupMap(read(GROUPS_PATH), GROUPS_PATH);

  const present = KINDS.filter((kind) => file[kind] !== undefined).map((kind) => ({
    kind,
    dataset: file[kind] as RawDataset,
  }));

  if (present.length === 0) {
    process.stderr.write(`datasets: ${DATASETS_PATH} declares no dataset\n`);
    return 1;
  }

  if (!argv.includes("--check")) {
    for (const { dataset } of present) {
      dataset.contentHash = datasetContentHash(
        dataset.items as unknown as readonly { id: string; split: "development" | "held-out" }[],
      );
    }
    writeFileSync(datasetsPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    process.stdout.write(
      `datasets: wrote ${String(present.length)} content hash(es) into ${datasetsPath}\n`,
    );
    return 0;
  }

  const problems: string[] = [];

  for (const { kind, dataset } of present) {
    if (dataset.contentHash === undefined) {
      problems.push(
        `${kind}: declares no contentHash. Without one, PRD 8.1's re-labelling check is off ` +
          `while the file looks exactly like one that passes it. Run \`pnpm datasets:hash\`.`,
      );
      continue;
    }
    try {
      // Recomputes the hash and refuses a mismatch. This is the re-labelling check itself.
      loadDataset(dataset as never);
    } catch (error) {
      problems.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const underCheck: DatasetUnderCheck[] = present.map(({ kind, dataset }) => ({
    name: kind,
    corpusSnapshot: dataset.corpusSnapshot,
    items: labelled(dataset.kind, dataset.items),
  }));

  for (const problem of checkDatasets(underCheck, inventory, memberships)) {
    problems.push(`${problem.dataset} ${problem.item}: ${problem.message}`);
  }

  if (problems.length > 0) {
    process.stderr.write(`datasets: ${String(problems.length)} problem(s)\n\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n\n`);
    return 1;
  }

  const items = present.reduce((total, { dataset }) => total + dataset.items.length, 0);
  process.stdout.write(
    `datasets: ${String(present.length)} dataset(s), ${String(items)} item(s), labelled against ` +
      `${inventory.corpusSnapshot}\n`,
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`datasets: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
