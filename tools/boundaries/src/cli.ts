/**
 * `pnpm boundaries:check` and `pnpm boundaries:table`.
 *
 * Exit codes matter more than output here: this runs in CI, and a checker that reports a violation
 * on stdout while exiting zero is worse than no checker, because it looks like one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "./check.js";
import { renderEvidence } from "./evidence.js";
import {
  edgesFrom,
  listSourceFiles,
  ownerOfFile,
  readSources,
  workspacePackageNames,
} from "./graph.js";
import { loadManifest, ManifestError } from "./manifest.js";
import { renderTable } from "./table.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(here, "..", "..", "..");
const MANIFEST_PATH = join(REPOSITORY_ROOT, "tools", "boundaries", "layers.json");
const TABLE_PATH = join(REPOSITORY_ROOT, "docs", "MODULES.md");

/** The directories that hold constrained code. `tools/` is excluded: it builds the checker. */
const SCANNED_DIRECTORIES = ["packages", "apps", "exhibits"] as const;

function collectFiles(): string[] {
  const files: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) {
    const absolute = join(REPOSITORY_ROOT, directory);
    if (!existsSync(absolute)) continue;
    for (const file of listSourceFiles(absolute)) {
      files.push(`${directory}/${file}`);
    }
  }
  return files.sort();
}

function runCheck(): number {
  const manifest = loadManifest(MANIFEST_PATH);
  const files = collectFiles();
  const owners = new Map(files.map((file) => [file, ownerOfFile(manifest, file)]));
  const sources = readSources(REPOSITORY_ROOT, files);
  const edges = edgesFrom(manifest, sources, workspacePackageNames(REPOSITORY_ROOT, manifest));
  const violations = check({ root: REPOSITORY_ROOT, manifest, files, edges, owners, sources });

  if (violations.length > 0) {
    process.stderr.write(`boundaries: ${String(violations.length)} violation(s)\n\n`);
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.rule}\n    ${violation.file}\n    ${violation.message}\n\n`,
      );
    }
    return 1;
  }

  process.stdout.write(
    `boundaries: ${String(files.length)} source file(s) across ${String(manifest.packages.length)} declared ` +
      `module(s), ${String(edges.length)} import(s), no violations\n`,
  );
  return 0;
}

function runTable(write: boolean): number {
  const manifest = loadManifest(MANIFEST_PATH);
  const rendered = renderTable(manifest);

  if (write) {
    writeFileSync(TABLE_PATH, `${rendered.trimEnd()}\n`, "utf8");
    process.stdout.write("boundaries: wrote docs/MODULES.md\n");
    return 0;
  }

  if (!existsSync(TABLE_PATH)) {
    process.stderr.write("boundaries: docs/MODULES.md is missing. Run `pnpm boundaries:table`.\n");
    return 1;
  }

  if (readFileSync(TABLE_PATH, "utf8").trimEnd() !== rendered.trimEnd()) {
    process.stderr.write(
      "boundaries: docs/MODULES.md is out of date with tools/boundaries/layers.json.\n" +
        "Run `pnpm boundaries:table` and commit the result.\n",
    );
    return 1;
  }

  process.stdout.write("boundaries: docs/MODULES.md is current\n");
  return 0;
}

/**
 * PRD 12 item 5's artefact.
 *
 * It refuses to write one when the check fails. An evidence file recording its own failure is a
 * file somebody will find later and read as evidence of something.
 */
function runEvidence(argv: readonly string[], outputDir: string): number {
  const manifest = loadManifest(MANIFEST_PATH);
  const files = collectFiles();
  const owners = new Map(files.map((file) => [file, ownerOfFile(manifest, file)]));
  const sources = readSources(REPOSITORY_ROOT, files);
  const edges = edgesFrom(manifest, sources, workspacePackageNames(REPOSITORY_ROOT, manifest));
  const violations = check({ root: REPOSITORY_ROOT, manifest, files, edges, owners, sources });

  if (violations.length > 0) {
    process.stderr.write(
      `boundaries: ${String(violations.length)} violation(s); no evidence artefact was written\n`,
    );
    return 1;
  }

  const at = argv.indexOf("--commit");
  const commit = at === -1 ? null : (argv[at + 1] ?? null);

  const rendered = renderEvidence({
    manifest,
    files,
    edges,
    violations: 0,
    commit,
    measuredAt: new Date().toISOString(),
  });

  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, "boundaries.md");
  writeFileSync(path, rendered, "utf8");
  process.stdout.write(`boundaries: wrote ${path}\n`);
  return 0;
}

function main(argv: readonly string[]): number {
  const command = argv[0] ?? "check";
  try {
    if (command === "check") {
      const checkResult = runCheck();
      const tableResult = runTable(false);
      return checkResult === 0 && tableResult === 0 ? 0 : 1;
    }
    if (command === "table") return runTable(argv.includes("--write"));
    if (command === "evidence") {
      const at = argv.indexOf("--out");
      return runEvidence(argv, at === -1 ? "evidence" : (argv[at + 1] ?? "evidence"));
    }
  } catch (error) {
    if (error instanceof ManifestError) {
      process.stderr.write(`boundaries: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  process.stderr.write(
    `boundaries: unknown command "${command}" (expected "check", "table" or "evidence")\n`,
  );
  return 1;
}

process.exitCode = main(process.argv.slice(2));
