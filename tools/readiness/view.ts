/**
 * What the verdict is allowed to see: files, by repository-relative path.
 *
 * **Everything the verdict decides, it decides from this.** It imports no workspace package, runs
 * no command and calls no model, so a verdict cannot depend on anything a reviewer could not open
 * in the repository — which is the point of deciding from artefacts rather than from prose. The
 * readiness test asserts the import half of that against the source files, rather than trusting
 * this comment.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface RepositoryView {
  /** The file's text, or `null` when it does not exist. Paths are relative and `/`-separated. */
  read(path: string): string | null;
  /** Every tracked-looking source file whose name ends in `.test.ts`, as relative paths. */
  testFiles(): readonly string[];
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".git", "evidence"]);

function walk(root: string, directory: string, into: string[]): void {
  for (const name of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const full = join(directory, name);
    if (statSync(full).isDirectory()) walk(root, full, into);
    else if (name.endsWith(".test.ts")) into.push(relative(root, full).split(sep).join("/"));
  }
}

/** A view over a directory on disk. */
export function directoryView(root: string): RepositoryView {
  let tests: string[] | undefined;
  return {
    read(path) {
      const full = join(root, ...path.split("/"));
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },
    testFiles() {
      if (tests === undefined) {
        tests = [];
        for (const top of ["packages", "apps", "exhibits", "tools"]) {
          const directory = join(root, top);
          if (existsSync(directory)) walk(root, directory, tests);
        }
        tests.sort();
      }
      return tests;
    },
  };
}

/** A view over an in-memory map, falling back to `base` for anything the map does not name. */
export function overlayView(
  base: RepositoryView,
  overrides: Readonly<Record<string, string | null>>,
): RepositoryView {
  return {
    read(path) {
      return Object.hasOwn(overrides, path) ? (overrides[path] ?? null) : base.read(path);
    },
    testFiles() {
      const removed = new Set(Object.keys(overrides).filter((path) => overrides[path] === null));
      const added = Object.keys(overrides).filter(
        (path) => path.endsWith(".test.ts") && overrides[path] !== null,
      );
      return [
        ...new Set([...base.testFiles().filter((path) => !removed.has(path)), ...added]),
      ].sort();
    },
  };
}

/** Parses JSON, returning `null` rather than throwing: an unreadable artefact is a finding. */
export function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Non-empty lines of a JSON Lines file. */
export function jsonLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Resolves an RFC 6901 JSON pointer. The proposal records one for every number it promotes, and
 * the test resolves each against the artefact it names — which is how "no number is promoted that
 * its artefact does not contain" is checked rather than asserted.
 */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let at: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(at)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      at = at[index];
    } else if (isRecord(at)) {
      at = at[key];
    } else {
      return undefined;
    }
  }
  return at;
}
