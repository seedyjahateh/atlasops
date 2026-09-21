/**
 * The boundary-enforcement artefact (PRD 12 item 5).
 *
 * "CI output showing `pnpm boundaries:check` passing, plus the generated dependency graph,
 * demonstrating that at least two exhibits consume `packages/*` and import no other exhibit. This
 * is what converts section 11 from a plan into a fact."
 *
 * The first two clauses this repository can produce. The third it cannot: there are no exhibits,
 * so there is nothing to demonstrate about how exhibits behave, and **this generator says so rather
 * than quietly rendering the half it can**. A report that showed a passing check and a dependency
 * graph without mentioning the missing requirement would read as though item 5 were satisfied —
 * which is exactly the shape of the claim PRD section 0 exists to prevent.
 *
 * The graph is emitted as edges between modules rather than as a picture. A picture needs a
 * renderer nobody has installed and cannot be diffed; a sorted edge list changes when the
 * dependency structure changes and not otherwise, so a reviewer can see in a pull request that a
 * module acquired a dependency.
 */

import type { Edge } from "./graph.js";
import { EXTERNAL, UNOWNED } from "./graph.js";
import type { Manifest } from "./manifest.js";

export interface EvidenceInput {
  readonly manifest: Manifest;
  readonly files: readonly string[];
  readonly edges: readonly Edge[];
  /** Zero when the check passed. Anything else and the artefact is not written. */
  readonly violations: number;
  readonly commit: string | null;
  readonly measuredAt: string;
}

/** Module-to-module edges, deduplicated and sorted. Internal only; externals are not the subject. */
export function moduleGraph(edges: readonly Edge[]): readonly string[] {
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.toOwner === EXTERNAL || edge.toOwner === UNOWNED) continue;
    if (edge.fromOwner === edge.toOwner) continue;
    seen.add(`${edge.fromOwner} -> ${edge.toOwner}`);
  }
  return [...seen].sort();
}

export function exhibitCount(files: readonly string[]): number {
  const exhibits = new Set<string>();
  for (const file of files) {
    if (!file.startsWith("exhibits/")) continue;
    const name = file.split("/")[1];
    if (name !== undefined) exhibits.add(name);
  }
  return exhibits.size;
}

export function renderEvidence(input: EvidenceInput): string {
  const graph = moduleGraph(input.edges);
  const exhibits = exhibitCount(input.files);

  return [
    "# Boundary enforcement",
    "",
    `- **Commit:** ${input.commit ?? "not recorded"}`,
    `- **Generated:** ${input.measuredAt}`,
    "",
    "## Check result",
    "",
    input.violations === 0
      ? `\`pnpm boundaries:check\` passed over ${String(input.files.length)} source file(s) in ` +
        `${String(input.manifest.packages.length)} declared module(s) and ` +
        `${String(input.edges.length)} import(s).`
      : `\`pnpm boundaries:check\` reported ${String(input.violations)} violation(s).`,
    "",
    "Two mechanisms enforce the same rule and are generated from one manifest: a",
    "`no-restricted-imports` zone per package, which fails `pnpm lint` at the file that wrote the",
    "import, and this checker, which walks the resolved graph and catches what lint cannot —",
    "transitive edges, imports reached through re-exports, and cycles.",
    "",
    "## Module graph",
    "",
    "Edges between declared modules, deduplicated and sorted. Emitted as text rather than as a",
    "picture so that a pull request shows a module acquiring a dependency as a diff.",
    "",
    "```text",
    ...(graph.length === 0 ? ["(no internal edges)"] : graph),
    "```",
    "",
    "## What this artefact does not yet demonstrate",
    "",
    `PRD 12 item 5 requires the graph to show **at least two exhibits consuming \`packages/*\` and`,
    "importing no other exhibit**. This repository contains " +
      (exhibits === 0 ? "**no exhibits**" : `**${String(exhibits)}**`) +
      ", so that requirement is **not met** and item 5 remains outstanding.",
    "",
    "The rule itself is enforced — `exhibit-is-a-leaf` is implemented, tested against a deliberately",
    "introduced violation, and would fail CI today. What is missing is the demonstration that it",
    "holds across real exhibits, and an enforced rule with nothing to enforce it against is a",
    "weaker claim than a rule two independent exhibits have had to live with. See",
    "`docs/promotion-readiness.md`.",
    "",
  ].join("\n");
}
