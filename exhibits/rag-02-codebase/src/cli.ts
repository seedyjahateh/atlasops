/**
 * `pnpm exhibit:rag-02 -- --principal prn_dev "how is the retry backoff computed"`
 * `pnpm exhibit:rag-02 -- --evaluate`
 *
 * Every model is a stand-in, so the answer prose is a quotation rather than an explanation, and the
 * evaluation numbers measure a stand-in embedder over a four-file fixture. What is real is where the
 * citations point, which repository they are allowed to point into, and which related symbols are
 * listed — and those are what this command exists to show.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAssistant } from "./assistant.js";
import { evaluate, loadCodebaseDataset } from "./evaluate.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "..", "fixtures");

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

async function main(argv: readonly string[]): Promise<number> {
  const assistant = await createAssistant({
    repositoryRoot: join(FIXTURES, "repos"),
    aclManifest: join(FIXTURES, "acl.json"),
    groupMap: join(FIXTURES, "groups.json"),
  });

  if (argv.includes("--evaluate")) {
    const dataset = loadCodebaseDataset(join(FIXTURES, "dataset.json"));
    const scores = await evaluate(dataset, assistant, assistant.ranked);
    process.stdout.write(
      `rag-02: ${dataset.id}@${dataset.version}, ${String(scores.items)} scorable item(s)\n` +
        `  recall@5  ${scores.recallAt5.toFixed(4)}\n` +
        `  MRR       ${scores.mrr.toFixed(4)}\n` +
        `  unscorable (no readable relevant symbol): ${scores.unscorable.join(", ") || "none"}\n` +
        `  cross-repository calls dropped from the graph: ${String(assistant.graph.crossRepositoryCalls)}\n\n` +
        `These numbers measure a stand-in embedder over a four-file fixture labelled by its author.\n` +
        `They show the evaluation runs against symbol-keyed labels; they say nothing about retrieval quality.\n`,
    );
    return 0;
  }

  const principal = flag(argv, "principal") ?? "prn_dev";
  const query = argv
    .filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--principal")
    .join(" ");
  if (query.length === 0) {
    process.stderr.write(
      'rag-02: ask something, e.g. --principal prn_dev "how is the retry backoff computed"\n',
    );
    return 1;
  }

  const result = await assistant.ask(principal, query);
  process.stdout.write(`${result.message}\n\n`);
  for (const citation of result.citations) {
    process.stdout.write(
      `  ${citation.rendered}  (${citation.symbols.join(", ")}; ${citation.precision}) @ ${citation.version}\n`,
    );
  }
  for (const entry of result.related) {
    const names = (refs: readonly { path: string; name: string }[]): string =>
      refs.map((ref) => `${ref.path}#${ref.name}`).join(", ") || "none";
    process.stdout.write(
      `  ${entry.of}\n    callers: ${names(entry.callers)}\n    callees: ${names(entry.callees)}\n`,
    );
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`rag-02: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
