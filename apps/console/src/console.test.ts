/**
 * Console tests.
 *
 * A read-only view over files somebody else wrote is a small surface with two ways to go wrong: it
 * can serve a file it should not, and it can render content as markup. Both are tested here, and
 * both are refused by construction rather than by a filter — the artefact name has to be one the
 * directory listing already produced, and every string is escaped into a `<pre>`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  escapeHtml,
  handleConsole,
  listArtefacts,
  readArtefact,
  readConsoleConfig,
  renderIndex,
} from "./console.js";

const roots: string[] = [];

function evidence(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "atlasops-console-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, "utf8");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configuration", () => {
  it("defaults the port and the evidence directory", () => {
    const config = readConsoleConfig({});
    expect(config.port).toBe(8081);
    expect(config.evidenceDir).toBe("evidence");
  });

  it("refuses a port that is not a port", () => {
    expect(() => readConsoleConfig({ ATLASOPS_CONSOLE_PORT: "-1" })).toThrow(ConfigError);
  });
});

describe("listing artefacts", () => {
  it("lists markdown files in order", () => {
    const dir = evidence({ "b.md": "b", "a.md": "a", "notes.txt": "x" });
    expect(listArtefacts(dir)).toEqual(["a.md", "b.md"]);
  });

  it("treats a missing directory as empty rather than as an error", () => {
    // A console started before the first evaluation run is a normal state.
    expect(listArtefacts(join(tmpdir(), "atlasops-does-not-exist"))).toEqual([]);
  });

  it("says so when there is nothing to show", () => {
    const rendered = renderIndex({ port: 8081, evidenceDir: evidence({}) });
    expect(rendered).toContain("No artefacts");
  });
});

describe("reading an artefact", () => {
  it("serves a file the listing produced", () => {
    const dir = evidence({ "run.md": "# Run\n" });
    expect(readArtefact(dir, "run.md")).toBe("# Run\n");
  });

  it("refuses a path that climbs out of the directory", () => {
    // Allow-listing against the listing rather than blocking `..`: a blocklist is the version of
    // this that gets bypassed.
    const dir = evidence({ "run.md": "# Run\n" });
    expect(readArtefact(dir, "../../etc/passwd")).toBeNull();
    expect(readArtefact(dir, "..\\..\\secrets.md")).toBeNull();
  });

  it("refuses a file the listing does not include", () => {
    const dir = evidence({ "run.md": "# Run\n", "secret.env": "TOKEN=1" });
    expect(readArtefact(dir, "secret.env")).toBeNull();
  });
});

describe("rendering", () => {
  it("escapes everything it renders", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("renders artefact content as text, not as markup", () => {
    const dir = evidence({ "run.md": "<img src=x onerror=alert(1)>" });
    const response = handleConsole(
      { port: 8081, evidenceDir: dir },
      "GET",
      "/artefact?name=run.md",
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("&lt;img");
    expect(response.body).not.toContain("<img");
  });

  it("states that answers and traces are not available, rather than showing an empty panel", () => {
    // With the memory profile the API's audit records are in another process's heap. A polished
    // empty panel would be the more convincing way to mislead somebody.
    const rendered = renderIndex({ port: 8081, evidenceDir: evidence({}) });
    expect(rendered).toContain("Answers and traces are not shown");
    expect(rendered).toContain("memory");
  });
});

describe("routing", () => {
  it("refuses anything that is not a GET before looking at the path", () => {
    const dir = evidence({ "run.md": "# Run\n" });
    const response = handleConsole(
      { port: 8081, evidenceDir: dir },
      "DELETE",
      "/artefact?name=run.md",
    );
    expect(response.status).toBe(405);
  });

  it("serves the index", () => {
    const dir = evidence({ "run.md": "# Run\n" });
    const response = handleConsole({ port: 8081, evidenceDir: dir }, "GET", "/");
    expect(response.status).toBe(200);
    expect(response.body).toContain("run.md");
  });

  it("returns 404 for an artefact that is not there", () => {
    const dir = evidence({});
    expect(
      handleConsole({ port: 8081, evidenceDir: dir }, "GET", "/artefact?name=x.md").status,
    ).toBe(404);
  });

  it("returns 404 for an unknown path", () => {
    const dir = evidence({});
    expect(handleConsole({ port: 8081, evidenceDir: dir }, "GET", "/admin").status).toBe(404);
  });
});
