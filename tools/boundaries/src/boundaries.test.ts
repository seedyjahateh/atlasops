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
  providerEndpoints: {
    allowedIn: ["@atlasops/model-gateway"],
    patterns: ["api.openai.com"],
  },
});

const manifest: Manifest = parseManifest(MANIFEST_SOURCE);

function edge(fromFile: string, fromOwner: string, specifier: string, toOwner: string): Edge {
  return { fromFile, fromOwner, specifier, toOwner };
}

function run(
  edges: readonly Edge[],
  files: readonly string[] = [],
  sources: ReadonlyMap<string, string> = new Map(),
): Violation[] {
  const owners = new Map(files.map((file) => [file, ownerOfFile(manifest, file)]));
  return check({ root: "/nowhere", manifest, files, edges, owners, sources });
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
      providerEndpoints: { allowedIn: [], patterns: [] },
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

  describe("an exhibit or application imported by its package name (P16)", () => {
    // Found by building the first exhibit: the leaf rules had only ever been demonstrated against
    // relative-path imports. A workspace package imported by its name resolved to EXTERNAL and
    // passed as though it were an npm dependency — which is the normal way to import one.
    const names = new Map([
      ["@atlasops/exhibit-rag-02-codebase", "exhibits/rag-02-codebase"],
      ["@atlasops/api", "apps/api"],
    ]);

    it("resolves the name to the member that owns it", () => {
      expect(
        ownerOfSpecifier(
          manifest,
          "packages/governance/src/a.ts",
          "@atlasops/exhibit-rag-02-codebase",
          names,
        ),
      ).toBe("exhibits/rag-02-codebase");
      expect(
        ownerOfSpecifier(
          manifest,
          "packages/governance/src/a.ts",
          "@atlasops/api/src/config.js",
          names,
        ),
      ).toBe("apps/api");
    });

    it("fails a package importing an exhibit by name", () => {
      const violations = run([
        edge(
          "packages/governance/src/a.ts",
          "@atlasops/governance",
          "@atlasops/exhibit-rag-02-codebase",
          ownerOfSpecifier(
            manifest,
            "packages/governance/src/a.ts",
            "@atlasops/exhibit-rag-02-codebase",
            names,
          ),
        ),
      ]);
      expect(violations[0]?.rule).toBe("exhibit-is-a-leaf");
    });

    it("still treats a genuine npm package as external", () => {
      expect(ownerOfSpecifier(manifest, "packages/governance/src/a.ts", "typescript", names)).toBe(
        EXTERNAL,
      );
    });
  });

  it("reports an unowned source file", () => {
    const violations = run([], ["packages/stray/src/index.ts"]);
    expect(violations[0]?.rule).toBe("unowned-source");
  });

  /**
   * The rule that exists because the adapter has no SDK to key on (ADR 0006).
   *
   * `provider-sdk-outside-gateway` watches imports. A bare `fetch("https://api.openai.com/…")` is
   * not an import, so without this the gateway boundary would be enforced against a shape nothing
   * in this repository uses — passing CI while any package talked to the provider directly.
   */
  describe("a provider endpoint is confined to the gateway too", () => {
    const file = "packages/governance/src/acl.ts";

    it("flags the host outside the gateway", () => {
      const sources = new Map([[file, 'await fetch("https://api.openai.com/v1/embeddings");']]);
      const violations = run([], [file], sources);
      expect(violations[0]?.rule).toBe("provider-endpoint-outside-gateway");
      expect(violations[0]?.message).toMatch(/bare fetch is not an import/);
    });

    it("permits it in the gateway, which is the one module that may reach a provider", () => {
      const inside = "packages/model-gateway/src/openai.ts";
      const sources = new Map([[inside, 'const BASE = "https://api.openai.com/v1";']]);
      expect(run([], [inside], sources)).toEqual([]);
    });

    it("flags it in a comment as well, and that is deliberate", () => {
      // Blunt on purpose: the alternative is deciding which occurrences are load-bearing, which is
      // the judgement that lets the real one through. Saying "the provider's API" satisfies it.
      const sources = new Map([[file, "// see api.openai.com for the response shape"]]);
      expect(run([], [file], sources)).toHaveLength(1);
    });

    it("says nothing about a file that names no provider", () => {
      const sources = new Map([[file, "export const x = 1;"]]);
      expect(run([], [file], sources)).toEqual([]);
    });
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
