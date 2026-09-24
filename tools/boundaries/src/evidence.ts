/**
 * The boundary-enforcement artefact (PRD 12 item 5).
 *
 * "CI output showing `pnpm boundaries:check` passing, plus the generated dependency graph,
 * demonstrating that at least two exhibits consume `packages/*` and import no other exhibit. This
 * is what converts section 11 from a plan into a fact."
 *
 * **The verdict on the third clause is computed from the graph, every time.** When this generator
 * was first written there were no exhibits, and it said "not met" unconditionally — correct, and
 * also a sentence that could never change, which is not evidence of anything. It now reads each
 * exhibit's outgoing edges and decides. A report that rendered a passing check and a graph without
 * a verdict would read as though item 5 were satisfied whether or not it was; one whose verdict was
 * edited by hand would be the claim PRD section 0 exists to prevent.
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
  return exhibitsIn(files).length;
}

function exhibitsIn(files: readonly string[]): readonly string[] {
  const exhibits = new Set<string>();
  for (const file of files) {
    if (!file.startsWith("exhibits/")) continue;
    const name = file.split("/")[1];
    if (name !== undefined) exhibits.add(`exhibits/${name}`);
  }
  return [...exhibits].sort();
}

/** What the graph shows one exhibit doing. */
export interface ExhibitFinding {
  readonly exhibit: string;
  /** Declared packages it imports. */
  readonly consumes: readonly string[];
  /** Other exhibits or applications it imports. Must be empty for item 5. */
  readonly leaks: readonly string[];
}

/**
 * PRD 12 item 5, decided from the edges rather than asserted.
 *
 * The earlier version of this generator said "not met" unconditionally, because when it was
 * written there were no exhibits to look at. A verdict that cannot change is not evidence of
 * anything, so this reads the graph: each exhibit must import at least one declared package, and
 * none may import another exhibit or an application. Two exhibits meeting both is the requirement.
 */
export function exhibitFindings(input: EvidenceInput): readonly ExhibitFinding[] {
  const packages = new Set(input.manifest.packages.map((pkg) => pkg.id));

  return exhibitsIn(input.files).map((exhibit) => {
    const outgoing = input.edges.filter(
      (edge) => edge.fromOwner === exhibit && edge.toOwner !== exhibit,
    );
    const consumes = [
      ...new Set(outgoing.filter((edge) => packages.has(edge.toOwner)).map((edge) => edge.toOwner)),
    ].sort();
    const leaks = [
      ...new Set(
        outgoing
          .filter(
            (edge) => edge.toOwner.startsWith("exhibits/") || edge.toOwner.startsWith("apps/"),
          )
          .map((edge) => edge.toOwner),
      ),
    ].sort();
    return { exhibit, consumes, leaks };
  });
}

export function itemFiveMet(findings: readonly ExhibitFinding[]): boolean {
  const qualifying = findings.filter(
    (finding) => finding.consumes.length > 0 && finding.leaks.length === 0,
  );
  return qualifying.length >= 2 && findings.every((finding) => finding.leaks.length === 0);
}

export function renderEvidence(input: EvidenceInput): string {
  const graph = moduleGraph(input.edges);
  const findings = exhibitFindings(input);
  const met = input.violations === 0 && itemFiveMet(findings);
  const exhibits = findings.length;

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
    "## Exhibits",
    "",
    "Read from the graph above, not declared: which packages each exhibit imports, and whether it",
    "imports any other exhibit or any application.",
    "",
    ...(exhibits === 0
      ? ["No exhibits exist."]
      : [
          "| Exhibit | Packages consumed | Imports another exhibit or application |",
          "| ------- | ----------------- | -------------------------------------- |",
          ...findings.map(
            (finding) =>
              `| \`${finding.exhibit}\` | ${String(finding.consumes.length)} | ` +
              `${finding.leaks.length === 0 ? "none" : finding.leaks.join(", ")} |`,
          ),
        ]),
    "",
    "## PRD 12 item 5",
    "",
    "Item 5 requires the graph to show **at least two exhibits consuming `packages/*` and importing",
    "no other exhibit**.",
    "",
    met
      ? `**Met.** ${String(findings.filter((finding) => finding.consumes.length > 0).length)} ` +
        "exhibits consume declared packages and none imports another exhibit or an application, " +
        "and the check passed. This verdict is computed from the edges each time the artefact is " +
        "generated; it is not a sentence somebody edited."
      : `**Not met.** This repository contains ${exhibits === 0 ? "**no exhibits**" : `**${String(exhibits)}**`}` +
        (findings.some((finding) => finding.leaks.length > 0)
          ? ", and at least one imports another exhibit or an application"
          : "") +
        ", so item 5 remains outstanding.",
    "",
    "The rule is enforced in two forms — an import by relative path and an import by workspace",
    "package name. Until P16 only the first was caught: a package importing an exhibit by its name",
    "resolved as an npm dependency and passed. See `docs/promotion-readiness.md`.",
    "",
  ].join("\n");
}
