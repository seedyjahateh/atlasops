/**
 * `pnpm corpus:inventory` and `pnpm corpus:inventory --check`.
 *
 * Separate from `inventory.ts` so that importing the builder — which a test does — cannot run a
 * command as a side effect. A module that writes a file when somebody imports it is a module that
 * eventually writes a file somebody did not ask for.
 *
 * Exit codes carry the result, because `--check` runs inside `pnpm verify`: a checker that prints a
 * complaint and exits zero is worse than no checker, since it looks like one.
 */

import { existsSync, readFileSync } from "node:fs";

import { buildInventory, renderInventory, writeInventory, INVENTORY_FILE } from "./inventory.js";

async function main(argv: readonly string[]): Promise<number> {
  const inventory = await buildInventory();
  const chunks = inventory.sources.reduce((total, source) => total + source.chunks.length, 0);

  if (!argv.includes("--check")) {
    writeInventory(inventory);
    process.stdout.write(
      `corpus: wrote examples/corpus.inventory.json — ${String(inventory.sources.length)} ` +
        `source(s), ${String(chunks)} chunk(s), snapshot ${inventory.corpusSnapshot}\n`,
    );
    return 0;
  }

  if (!existsSync(INVENTORY_FILE)) {
    process.stderr.write(
      "corpus: examples/corpus.inventory.json is missing. Run `pnpm corpus:inventory`.\n",
    );
    return 1;
  }

  if (readFileSync(INVENTORY_FILE, "utf8") !== renderInventory(inventory)) {
    process.stderr.write(
      "corpus: examples/corpus.inventory.json is out of date with examples/corpus.\n" +
        "Every dataset label points at a chunk identifier this file pins, so a corpus edit moves\n" +
        "identifiers and silently invalidates the labels that referenced them — every metric still\n" +
        "computes, over a corpus the labels were not written for.\n" +
        "Run `pnpm corpus:inventory`, commit the result, and re-check the labels that moved.\n",
    );
    return 1;
  }

  process.stdout.write(
    `corpus: inventory is current — ${String(inventory.sources.length)} source(s), ` +
      `${String(chunks)} chunk(s), snapshot ${inventory.corpusSnapshot}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`corpus: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
