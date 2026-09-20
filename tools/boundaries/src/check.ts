/**
 * The rules, applied to the graph.
 *
 * Every violation carries the file that caused it and the rule it broke, because the failure mode
 * this tool exists to prevent is somebody reading "boundary violation" in CI, not knowing which
 * line did it, and widening the manifest to make the red go away.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { EXTERNAL, UNOWNED, edgeIsProviderSdk, type Edge } from "./graph.js";
import type { GroupRule, Manifest } from "./manifest.js";

export type RuleId =
  | "forbidden-import"
  | "exhibit-is-a-leaf"
  | "app-is-a-leaf"
  | "provider-sdk-outside-gateway"
  | "escapes-the-workspace"
  | "unowned-source"
  | "undeclared-package"
  | "dependency-cycle";

export interface Violation {
  readonly rule: RuleId;
  readonly file: string;
  readonly message: string;
}

function groupOf(manifest: Manifest, owner: string): GroupRule | undefined {
  return manifest.groups.find((group) => owner.startsWith(group.pathPrefix));
}

function isPackage(manifest: Manifest, owner: string): boolean {
  return manifest.packages.some((pkg) => pkg.id === owner);
}

/** Whether `from` is permitted to import `to`. Intra-module edges are always fine. */
export function permits(manifest: Manifest, from: string, to: string): boolean {
  if (from === to) return true;
  if (to === EXTERNAL) return true;
  if (to === UNOWNED) return false;

  const fromPackage = manifest.packages.find((pkg) => pkg.id === from);
  if (fromPackage !== undefined) return fromPackage.mayImport.includes(to);

  const fromGroup = groupOf(manifest, from);
  if (fromGroup !== undefined) {
    if (isPackage(manifest, to)) return fromGroup.mayImportAnyPackage;
    const toGroup = groupOf(manifest, to);
    if (toGroup === undefined) return false;
    return fromGroup.mayImportGroups.includes(toGroup.id);
  }

  return false;
}

function checkDeclaredPackages(root: string, manifest: Manifest): Violation[] {
  const violations: Violation[] = [];
  const packagesDirectory = join(root, "packages");
  if (!existsSync(packagesDirectory)) return violations;

  const declaredPaths = new Set(manifest.packages.map((pkg) => pkg.path));
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relativePath = `packages/${entry.name}`;
    if (!existsSync(join(packagesDirectory, entry.name, "package.json"))) continue;
    if (declaredPaths.has(relativePath)) continue;
    violations.push({
      rule: "undeclared-package",
      file: `${relativePath}/package.json`,
      message:
        `${relativePath} is a workspace package but has no entry in tools/boundaries/layers.json. ` +
        `An undeclared package is one nothing constrains.`,
    });
  }

  return violations;
}

function findCycle(edges: readonly Edge[]): string[] | null {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.toOwner === EXTERNAL || edge.toOwner === UNOWNED) continue;
    if (edge.fromOwner === edge.toOwner) continue;
    const targets = adjacency.get(edge.fromOwner) ?? new Set<string>();
    targets.add(edge.toOwner);
    adjacency.set(edge.fromOwner, targets);
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const current = state.get(node);
    if (current === "done") return null;
    if (current === "visiting") return [...stack.slice(stack.indexOf(node)), node];

    state.set(node, "visiting");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };

  for (const node of adjacency.keys()) {
    const cycle = visit(node);
    if (cycle !== null) return cycle;
  }
  return null;
}

export interface CheckInput {
  readonly root: string;
  readonly manifest: Manifest;
  readonly files: readonly string[];
  readonly edges: readonly Edge[];
  readonly owners: ReadonlyMap<string, string>;
}

export function check(input: CheckInput): Violation[] {
  const { root, manifest, files, edges, owners } = input;
  const violations: Violation[] = [...checkDeclaredPackages(root, manifest)];

  for (const file of files) {
    if (owners.get(file) === UNOWNED) {
      violations.push({
        rule: "unowned-source",
        file,
        message:
          `${file} belongs to no declared package or group. Either declare it in ` +
          `tools/boundaries/layers.json or move it under a module that is declared.`,
      });
    }
  }

  for (const edge of edges) {
    if (
      edgeIsProviderSdk(manifest, edge) &&
      !manifest.providerSdks.allowedIn.includes(edge.fromOwner)
    ) {
      violations.push({
        rule: "provider-sdk-outside-gateway",
        file: edge.fromFile,
        message:
          `${edge.fromOwner} imports the provider SDK "${edge.specifier}". Only ` +
          `${manifest.providerSdks.allowedIn.join(", ")} may do that — everything above it talks to ` +
          `an interface, which is what lets downstream tests run against the deterministic fake.`,
      });
      continue;
    }

    if (edge.toOwner === EXTERNAL) continue;

    if (edge.toOwner === UNOWNED) {
      violations.push({
        rule: "escapes-the-workspace",
        file: edge.fromFile,
        message: `"${edge.specifier}" resolves outside every declared module.`,
      });
      continue;
    }

    if (permits(manifest, edge.fromOwner, edge.toOwner)) continue;

    const targetGroup = groupOf(manifest, edge.toOwner);
    if (targetGroup?.id === "exhibits") {
      violations.push({
        rule: "exhibit-is-a-leaf",
        file: edge.fromFile,
        message:
          `${edge.fromOwner} imports the exhibit ${edge.toOwner}. Nothing imports an exhibit — that ` +
          `is what lets any one of them be read, run, deleted or published on its own. If two ` +
          `exhibits need the same helper, promote it into a package.`,
      });
      continue;
    }

    if (targetGroup?.id === "apps") {
      violations.push({
        rule: "app-is-a-leaf",
        file: edge.fromFile,
        message: `${edge.fromOwner} imports the application ${edge.toOwner}. Applications are wiring, not libraries.`,
      });
      continue;
    }

    violations.push({
      rule: "forbidden-import",
      file: edge.fromFile,
      message:
        `${edge.fromOwner} imports ${edge.toOwner}, which its row in layers.json does not permit. ` +
        `Widening that row is its own change, with an ADR — not a line added beside the code that ` +
        `wanted it.`,
    });
  }

  const cycle = findCycle(edges);
  if (cycle !== null) {
    violations.push({
      rule: "dependency-cycle",
      file: "tools/boundaries/layers.json",
      message: `dependency cycle: ${cycle.join(" → ")}`,
    });
  }

  return violations;
}
