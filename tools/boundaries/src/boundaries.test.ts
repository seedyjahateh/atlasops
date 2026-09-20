/**
 * The checker's own tests.
 *
 * These run against synthetic manifests and synthetic edges rather than against the real workspace,
 * which currently has no packages in it. That is the right way round regardless: a checker tested
 * only against a repository that happens to be clean is a checker whose failure path has never
 * executed, and the failure path is the entire product.
 */

import { describe, expect, it } from "vitest";

import { check, permits, type Violation } from "./check.js";
import { EXTERNAL, UNOWNED, ownerOfFile, ownerOfSpecifier, type Edge } from "./graph.js";
import { parseManifest, ManifestError, type Manifest } from "./manifest.js";

const MANIFEST_SOURCE = JSON.stringify({
  version: 1,
  layerNames: ["contracts", "telemetry", "platform", "runtime"],
  packages: {
    "@atlasops/contracts": { path: "packages/contracts", layer: 0, owns: "types", mayImport: [] },
    "@atlasops/telemetry": {
      path: "packages/telemetry",
      layer: 1,
      owns: "spans",
      mayImport: ["@atlasops/contracts"],
    },
    "@atlasops/governance": {
      path: "packages/governance",
      layer: 2,
      owns: "acls",
      mayImport: ["@atlasops/contracts", "@atlasops/telemetry"],
    },
    "@atlasops/model-gateway": {
      path: "packages/model-gateway",
      layer: 2,
      owns: "models",
      mayImport: ["@atlasops/contracts"],
    },
  },
  groups: {
    apps: {
      pathPrefix: "apps/",
      layer: 3,
      owns: "wiring",
      mayImportAnyPackage: true,
      mayImportGroups: [],
    },
    exhibits: {
      pathPrefix: "exhibits/",
      layer: 3,
      owns: "one idea each",
      mayImportAnyPackage: true,
      mayImportGroups: [],
    },
  },
  providerSdks: { allowedIn: ["@atlasops/model-gateway"], patterns: ["openai", "@anthropic-ai/*"] },
});

const manifest: Manifest = parseManifest(MANIFEST_SOURCE);

function edge(fromFile: string, fromOwner: string, specifier: string, toOwner: string): Edge {
  return { fromFile, fromOwner, specifier, toOwner };
}

function run(edges: readonly Edge[], files: readonly string[] = []): Violation[] {
  const owners = new Map(files.map((file) => [file, ownerOfFile(manifest, file)]));
  return check({ root: "/nowhere", manifest, files, edges, owners });
}

describe("manifest validation", () => {
  it("rejects a dependency on a package that does not exist", () => {
    const source = MANIFEST_SOURCE.replace('"@atlasops/contracts"]', '"@atlasops/nope"]');
    expect(() => parseManifest(source)).toThrow(ManifestError);
  });

  it("rejects a permitted edge that does not go downward", () => {
    /**
     * The manifest is held to the same rule as the code. Without this, layers.json could declare a
     * legal cycle and the checker would enforce it faithfully — the boundary would be gone and
     * every check would still be green, which is the worst available outcome.
     */
    const source = JSON.stringify({
      version: 1,
      layerNames: ["a", "b"],
      packages: {
        "@x/low": { path: "packages/low", layer: 0, owns: "l", mayImport: ["@x/high"] },
        "@x/high": { path: "packages/high", layer: 1, owns: "h", mayImport: [] },
      },
      groups: {},
      providerSdks: { allowedIn: [], patterns: [] },
    });
    expect(() => parseManifest(source)).toThrow(/strictly downward/);
  });

  it("rejects an unknown version rather than guessing", () => {
    expect(() => parseManifest(MANIFEST_SOURCE.replace('"version":1', '"version":99'))).toThrow(
      /unsupported manifest version/,
    );
  });

  it("reports malformed JSON as a manifest error, not a crash", () => {
    expect(() => parseManifest("{ not json")).toThrow(ManifestError);
  });
});

describe("ownership", () => {
  it("maps a file to its package", () => {
    expect(ownerOfFile(manifest, "packages/telemetry/src/span.ts")).toBe("@atlasops/telemetry");
  });

  it("maps a file to its group member, not the group", () => {
    expect(ownerOfFile(manifest, "exhibits/rag-07-hybrid/src/index.ts")).toBe(
      "exhibits/rag-07-hybrid",
    );
  });

  it("reports a file under no declared module as unowned", () => {
    expect(ownerOfFile(manifest, "packages/not-declared/src/index.ts")).toBe(UNOWNED);
  });

  it("treats node: builtins as external", () => {
    expect(ownerOfSpecifier(manifest, "packages/telemetry/src/a.ts", "node:fs")).toBe(EXTERNAL);
  });

  it("resolves a deep relative import to the package it actually reaches", () => {
    /**
     * `../../telemetry/src/span.js` is a boundary violation dressed as a local import. A checker
     * that only inspected bare specifiers would wave it through, so relative specifiers are
     * resolved to a path before ownership is decided.
     */
    expect(
      ownerOfSpecifier(manifest, "packages/contracts/src/id.ts", "../../telemetry/src/span.js"),
    ).toBe("@atlasops/telemetry");
  });

  it("keeps an intra-package relative import inside its own package", () => {
    expect(ownerOfSpecifier(manifest, "packages/contracts/src/id.ts", "./chunk.js")).toBe(
      "@atlasops/contracts",
    );
  });
});

describe("permission", () => {
  it("allows a declared downward edge", () => {
    expect(permits(manifest, "@atlasops/telemetry", "@atlasops/contracts")).toBe(true);
  });

  it("refuses an undeclared edge", () => {
    expect(permits(manifest, "@atlasops/contracts", "@atlasops/telemetry")).toBe(false);
  });

  it("lets an app import any package", () => {
    expect(permits(manifest, "apps/api", "@atlasops/governance")).toBe(true);
  });

  it("refuses one exhibit importing another", () => {
    expect(permits(manifest, "exhibits/rag-02-a", "exhibits/rag-03-b")).toBe(false);
  });

  it("refuses an app importing another app", () => {
    expect(permits(manifest, "apps/api", "apps/console")).toBe(false);
  });
});

describe("check", () => {
  it("passes a clean graph", () => {
    const edges = [
      edge(
        "packages/telemetry/src/a.ts",
        "@atlasops/telemetry",
        "@atlasops/contracts",
        "@atlasops/contracts",
      ),
      edge("apps/api/src/main.ts", "apps/api", "@atlasops/governance", "@atlasops/governance"),
    ];
    expect(run(edges)).toEqual([]);
  });

  it("fails a deliberately introduced illegal import, and passes once it is removed", () => {
    /**
     * This is the acceptance criterion for the whole phase: the boundary has to be a fact, not a
     * paragraph. `contracts` sits at layer 0 and may import nothing.
     */
    const illegal = edge(
      "packages/contracts/src/id.ts",
      "@atlasops/contracts",
      "@atlasops/telemetry",
      "@atlasops/telemetry",
    );

    const withViolation = run([illegal]);
    expect(withViolation).toHaveLength(1);
    expect(withViolation[0]?.rule).toBe("forbidden-import");
    expect(withViolation[0]?.file).toBe("packages/contracts/src/id.ts");

    expect(run([])).toEqual([]);
  });

  it("names the exhibit rule when an exhibit is imported", () => {
    const violations = run([
      edge("apps/api/src/main.ts", "apps/api", "exhibits/rag-02-a", "exhibits/rag-02-a"),
    ]);
    expect(violations[0]?.rule).toBe("exhibit-is-a-leaf");
    expect(violations[0]?.message).toContain("Nothing imports an exhibit");
  });

  it("allows a provider SDK inside the gateway and refuses it anywhere else", () => {
    const inside = edge(
      "packages/model-gateway/src/openai.ts",
      "@atlasops/model-gateway",
      "openai",
      EXTERNAL,
    );
    expect(run([inside])).toEqual([]);

    const outside = edge(
      "packages/governance/src/acl.ts",
      "@atlasops/governance",
      "@anthropic-ai/sdk",
      EXTERNAL,
    );
    const violations = run([outside]);
    expect(violations[0]?.rule).toBe("provider-sdk-outside-gateway");
  });

  it("reports an unowned source file", () => {
    const violations = run([], ["packages/stray/src/index.ts"]);
    expect(violations[0]?.rule).toBe("unowned-source");
  });

  it("detects a cycle between group members", () => {
    /**
     * Package cycles are already impossible once every edge is downward, but group members share a
     * layer, so two apps importing each other is the reachable case.
     */
    const violations = run([
      edge("apps/a/src/i.ts", "apps/a", "apps/b", "apps/b"),
      edge("apps/b/src/i.ts", "apps/b", "apps/a", "apps/a"),
    ]);
    expect(violations.some((violation) => violation.rule === "dependency-cycle")).toBe(true);
  });
});
