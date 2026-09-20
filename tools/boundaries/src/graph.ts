/**
 * The import graph, read from source rather than from `package.json` dependency lists.
 *
 * A declared dependency and an actual import are different facts, and it is the second one that
 * decides whether a boundary held. A package can list a dependency it never imports, and — the case
 * that matters — a file can import something its package never declared, which resolves fine in a
 * workspace where the dependency is hoisted and fails in a published build.
 *
 * Specifiers come from `ts.preProcessFile`, the scanner TypeScript uses for its own dependency
 * discovery. It catches static imports, `export … from`, dynamic `import()` and `require()` without
 * building a program, which keeps this fast enough to run on every commit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

import ts from "typescript";

import type { Manifest } from "./manifest.js";

/** Where an import came from and where it went, in repository-relative terms. */
export interface Edge {
  readonly fromFile: string;
  readonly fromOwner: string;
  readonly specifier: string;
  readonly toOwner: string;
}

/** An owner is a package id, a group member such as `exhibits/rag-02-x`, or a sentinel. */
export const EXTERNAL = "(external)";
export const UNOWNED = "(unowned)";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git", "fixtures"]);

function toPosix(value: string): string {
  return value.split(sep).join(posix.sep);
}

export function listSourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      found.push(toPosix(relative(root, join(directory, entry.name))));
    }
  };

  walk(root);
  return found.sort();
}

/**
 * Which module a repository-relative file belongs to.
 *
 * Longest matching path wins, so a package nested inside a group directory would still resolve to
 * the package. Nothing outside a declared package or group is owned, and section `check` treats an
 * unowned source file as a failure rather than ignoring it — an unowned file is one nothing
 * constrains.
 */
export function ownerOfFile(manifest: Manifest, file: string): string {
  let best = "";
  let owner = UNOWNED;

  for (const pkg of manifest.packages) {
    const prefix = `${toPosix(pkg.path)}/`;
    if (file.startsWith(prefix) && prefix.length > best.length) {
      best = prefix;
      owner = pkg.id;
    }
  }

  for (const group of manifest.groups) {
    const prefix = toPosix(group.pathPrefix);
    if (!file.startsWith(prefix)) continue;
    const remainder = file.slice(prefix.length);
    const member = remainder.split("/")[0];
    if (member === undefined || member.length === 0) continue;
    const candidate = `${prefix}${member}`;
    if (candidate.length > best.length) {
      best = candidate;
      owner = candidate;
    }
  }

  return owner;
}

function isProviderSdk(manifest: Manifest, specifier: string): boolean {
  return manifest.providerSdks.patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return specifier.startsWith(pattern.slice(0, -1));
    return specifier === pattern || specifier.startsWith(`${pattern}/`);
  });
}

/**
 * Which module a specifier points at, as seen from `fromFile`.
 *
 * Relative specifiers are resolved to a path first. That is deliberate: `../../telemetry/src/x` is
 * a boundary violation dressed as a local import, and a checker that only inspected bare specifiers
 * would wave it through.
 */
export function ownerOfSpecifier(manifest: Manifest, fromFile: string, specifier: string): string {
  if (specifier.startsWith(".")) {
    const fromDirectory = posix.dirname(fromFile);
    const resolved = posix.normalize(posix.join(fromDirectory, specifier));
    if (resolved.startsWith("..")) return UNOWNED;
    return ownerOfFile(manifest, resolved);
  }

  if (specifier.startsWith("node:")) return EXTERNAL;

  for (const pkg of manifest.packages) {
    if (specifier === pkg.id || specifier.startsWith(`${pkg.id}/`)) return pkg.id;
  }

  return EXTERNAL;
}

export function readEdges(root: string, manifest: Manifest, files: readonly string[]): Edge[] {
  const edges: Edge[] = [];

  for (const file of files) {
    const absolute = resolve(root, file);
    if (!statSync(absolute).isFile()) continue;
    const text = readFileSync(absolute, "utf8");
    const scanned = ts.preProcessFile(text, true, true);
    const fromOwner = ownerOfFile(manifest, file);

    for (const reference of scanned.importedFiles) {
      edges.push({
        fromFile: file,
        fromOwner,
        specifier: reference.fileName,
        toOwner: ownerOfSpecifier(manifest, file, reference.fileName),
      });
    }
  }

  return edges;
}

export function edgeIsProviderSdk(manifest: Manifest, edge: Edge): boolean {
  return edge.toOwner === EXTERNAL && isProviderSdk(manifest, edge.specifier);
}
