/**
 * Boundary-evidence tests (P12 item 5).
 *
 * The behaviour worth testing is the one that would be easiest to get wrong in the flattering
 * direction: the artefact must say that the two-exhibit requirement is unmet, rather than rendering
 * the half it can and letting the absence pass unremarked.
 */

import { describe, expect, it } from "vitest";

import { EXTERNAL, UNOWNED, type Edge } from "./graph.js";
import {
  exhibitCount,
  exhibitFindings,
  itemFiveMet,
  moduleGraph,
  renderEvidence,
} from "./evidence.js";
import type { Manifest } from "./manifest.js";

const MANIFEST: Manifest = {
  version: 1,
  layerNames: ["contracts", "telemetry"],
  packages: [
    {
      id: "@atlasops/contracts",
      path: "packages/contracts",
      layer: 0,
      owns: "types",
      mayImport: [],
    },
    {
      id: "@atlasops/telemetry",
      path: "packages/telemetry",
      layer: 1,
      owns: "spans",
      mayImport: ["@atlasops/contracts"],
    },
  ],
  groups: [],
  providerSdks: { allowedIn: [], patterns: [] },
  providerEndpoints: { allowedIn: [], patterns: [] },
};

function edge(fromOwner: string, toOwner: string): Edge {
  return { fromFile: `${fromOwner}/src/a.ts`, fromOwner, toOwner, specifier: toOwner };
}

const BASE = {
  manifest: MANIFEST,
  files: ["packages/contracts/src/a.ts", "packages/telemetry/src/b.ts"],
  edges: [edge("@atlasops/telemetry", "@atlasops/contracts")],
  violations: 0,
  commit: "abc123",
  measuredAt: "2026-05-01T00:00:00.000Z",
};

describe("the module graph", () => {
  it("deduplicates and sorts internal edges", () => {
    const graph = moduleGraph([
      edge("@atlasops/telemetry", "@atlasops/contracts"),
      edge("@atlasops/telemetry", "@atlasops/contracts"),
    ]);
    expect(graph).toEqual(["@atlasops/telemetry -> @atlasops/contracts"]);
  });

  it("omits external and unowned targets, which are not the subject", () => {
    expect(
      moduleGraph([edge("@atlasops/telemetry", EXTERNAL), edge("@atlasops/telemetry", UNOWNED)]),
    ).toEqual([]);
  });

  it("omits a module's edges to itself", () => {
    expect(moduleGraph([edge("@atlasops/telemetry", "@atlasops/telemetry")])).toEqual([]);
  });
});

describe("counting exhibits", () => {
  it("counts directories, not files", () => {
    expect(
      exhibitCount([
        "exhibits/rag-02-codebase/src/a.ts",
        "exhibits/rag-02-codebase/src/b.ts",
        "exhibits/rag-03-incident/src/a.ts",
        "packages/contracts/src/a.ts",
      ]),
    ).toBe(2);
  });

  it("is zero when there are none", () => {
    expect(exhibitCount(["packages/contracts/src/a.ts"])).toBe(0);
  });
});

describe("the artefact", () => {
  it("records the check result and the graph", () => {
    const rendered = renderEvidence(BASE);
    expect(rendered).toContain("passed over 2 source file(s)");
    expect(rendered).toContain("@atlasops/telemetry -> @atlasops/contracts");
    expect(rendered).toContain("**Commit:** abc123");
  });

  it("says the two-exhibit requirement is not met when there are no exhibits", () => {
    // The flattering version of this artefact renders the passing check and the graph and stops.
    const rendered = renderEvidence(BASE);
    expect(rendered).toContain("**no exhibits**");
    expect(rendered).toContain("**Not met.**");
    expect(rendered).toContain("promotion-readiness.md");
  });

  it("is not met with one exhibit", () => {
    const rendered = renderEvidence({
      ...BASE,
      files: [...BASE.files, "exhibits/rag-02/src/a.ts"],
      edges: [...BASE.edges, edge("exhibits/rag-02", "@atlasops/contracts")],
    });
    expect(rendered).toContain("**1**");
    expect(rendered).toContain("**Not met.**");
  });

  it("names both import forms the rule is enforced against", () => {
    // Until P16 only the relative-path form was caught, and the artefact said the rule held.
    expect(renderEvidence(BASE)).toContain("workspace");
  });
});

describe("item 5 is decided from the graph (P17b)", () => {
  // The generator used to say "not met" unconditionally. A verdict that cannot change is not
  // evidence, so these assert it changes exactly when the graph does.
  const twoExhibits = {
    ...BASE,
    files: [...BASE.files, "exhibits/rag-02/src/a.ts", "exhibits/rag-03/src/a.ts"],
    edges: [
      ...BASE.edges,
      edge("exhibits/rag-02", "@atlasops/contracts"),
      edge("exhibits/rag-03", "@atlasops/telemetry"),
    ],
  };

  it("is met by two exhibits that consume packages and import no other exhibit", () => {
    const findings = exhibitFindings(twoExhibits);
    expect(itemFiveMet(findings)).toBe(true);
    expect(renderEvidence(twoExhibits)).toContain("**Met.**");
  });

  it("is not met when one exhibit imports the other", () => {
    const leaking = {
      ...twoExhibits,
      edges: [...twoExhibits.edges, edge("exhibits/rag-03", "exhibits/rag-02")],
    };
    const findings = exhibitFindings(leaking);

    expect(findings.find((finding) => finding.exhibit === "exhibits/rag-03")?.leaks).toEqual([
      "exhibits/rag-02",
    ]);
    expect(itemFiveMet(findings)).toBe(false);
    expect(renderEvidence(leaking)).toContain("imports another exhibit or an application");
  });

  it("is not met when an exhibit imports an application", () => {
    const leaking = {
      ...twoExhibits,
      edges: [...twoExhibits.edges, edge("exhibits/rag-02", "apps/api")],
    };
    expect(itemFiveMet(exhibitFindings(leaking))).toBe(false);
  });

  it("does not count an exhibit that consumes no package", () => {
    // "Consuming packages/*" is half the requirement. A directory under exhibits/ that imports
    // nothing from the platform demonstrates nothing about the platform.
    const idle = {
      ...twoExhibits,
      edges: [...BASE.edges, edge("exhibits/rag-02", "@atlasops/contracts")],
    };
    expect(itemFiveMet(exhibitFindings(idle))).toBe(false);
  });

  it("is not met when the check did not pass, whatever the graph shows", () => {
    expect(renderEvidence({ ...twoExhibits, violations: 1 })).toContain("**Not met.**");
  });
});
