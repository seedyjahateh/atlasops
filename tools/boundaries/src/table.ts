/**
 * The module table, generated from the manifest.
 *
 * PRD 11.2 carries this table as prose. A prose table beside a machine-readable manifest is two
 * sources of truth that agree only until somebody edits one of them, so the document that ships in
 * this repository is generated and CI fails when the committed copy differs from what the manifest
 * produces.
 *
 * It is written to docs/MODULES.md rather than back into docs/prd/RAG-01-atlasops.md. The PRD here
 * is a mirror of the portfolio's canonical copy, and a generator that rewrites a mirrored document
 * would make the two diverge on every run — see docs/adr/0001.
 */

import type { Manifest } from "./manifest.js";

const GENERATED_NOTICE =
  "<!-- Generated from tools/boundaries/layers.json by `pnpm boundaries:table`. Do not edit by hand. -->";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatList(values: readonly string[], empty: string): string {
  if (values.length === 0) return empty;
  return values.map((value) => `\`${value}\``).join(", ");
}

export function renderTable(manifest: Manifest): string {
  const lines: string[] = [];

  lines.push("# Module boundaries");
  lines.push("");
  lines.push(GENERATED_NOTICE);
  lines.push("");
  lines.push(
    "Dependencies flow downward only and the graph stays acyclic. `pnpm boundaries:check` enforces",
  );
  lines.push(
    "this against the real import graph — not against declared dependencies, which is a different",
  );
  lines.push("fact and not the one that decides whether a boundary held.");
  lines.push("");
  lines.push("## Packages");
  lines.push("");
  lines.push("| Layer | Module | Owns | May import |");
  lines.push("| --- | --- | --- | --- |");

  const ordered = [...manifest.packages].sort((a, b) =>
    a.layer === b.layer ? a.id.localeCompare(b.id) : a.layer - b.layer,
  );

  for (const pkg of ordered) {
    const layerName = manifest.layerNames[pkg.layer] ?? String(pkg.layer);
    lines.push(
      `| ${String(pkg.layer)} ${escapeCell(layerName)} | \`${pkg.id}\` | ${escapeCell(pkg.owns)} | ` +
        `${formatList(pkg.mayImport, "_nothing_")} |`,
    );
  }

  lines.push("");
  lines.push("## Groups");
  lines.push("");
  lines.push("| Layer | Group | Owns | May import |");
  lines.push("| --- | --- | --- | --- |");

  for (const group of manifest.groups) {
    const layerName = manifest.layerNames[group.layer] ?? String(group.layer);
    const permitted = group.mayImportAnyPackage ? "any package" : "_nothing_";
    const groups =
      group.mayImportGroups.length === 0 ? "no group" : formatList(group.mayImportGroups, "");
    lines.push(
      `| ${String(group.layer)} ${escapeCell(layerName)} | \`${escapeCell(group.pathPrefix)}\` | ` +
        `${escapeCell(group.owns)} | ${permitted}, ${groups} |`,
    );
  }

  lines.push("");
  lines.push("## Provider SDKs");
  lines.push("");
  lines.push(
    `Reachable only from ${formatList(manifest.providerSdks.allowedIn, "_nowhere_")}. Everything above`,
  );
  lines.push(
    "it depends on an interface, which is what lets every downstream test run against the in-repo",
  );
  lines.push("deterministic fake instead of a paid API.");
  lines.push("");
  lines.push(`Matched patterns: ${formatList(manifest.providerSdks.patterns, "_none_")}.`);
  lines.push("");

  return lines.join("\n");
}
