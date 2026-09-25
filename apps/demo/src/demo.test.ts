/**
 * The walkthrough's properties, checked over the stand-ins.
 *
 * The demo prints "holds" or "DOES NOT HOLD" for each scene. This test makes the first answer the
 * only one the build accepts, so the walkthrough someone records cannot drift into demonstrating
 * something false. No test calls a paid API: the stand-ins answer.
 */

import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { buildDemo, RESTRICTED_PREFIX, SCENES, type Demo } from "./demo.js";
import { renderWalkthrough, runWalkthrough, type SceneResult } from "./walkthrough.js";

const path = (relative: string): string =>
  fileURLToPath(new URL(`../../../examples/${relative}`, import.meta.url));

let demo: Demo;
let scenes: SceneResult[];

beforeAll(async () => {
  demo = await buildDemo({
    corpusRoot: path("corpus"),
    aclManifest: path("corpus.acl.json"),
    groupMap: path("corpus.groups.json"),
    models: "stand-in",
    env: {},
  });
  scenes = await runWalkthrough(demo);
});

describe("the walkthrough", () => {
  it("runs five scenes, and every property holds", () => {
    expect(scenes).toHaveLength(5);
    for (const scene of scenes) expect(scene.holds, scene.title).toBe(true);
    expect(renderWalkthrough(demo, scenes)).toContain("All five properties held.");
  });

  it("lets the executive's question reach the hidden document, and not the reader's", async () => {
    // The pair that makes scene 2 mean something: without the first, the second proves nothing.
    const exec = await demo.ask("prn_exec", SCENES.hidden.query);
    const reader = await demo.ask("prn_reader", SCENES.hidden.query);
    expect(exec.sourcesInPrompt.some((source) => source.startsWith(RESTRICTED_PREFIX))).toBe(true);
    expect(reader.sourcesInPrompt.some((source) => source.startsWith(RESTRICTED_PREFIX))).toBe(
      false,
    );
  });

  it("reports DOES NOT HOLD when a property fails, rather than only ever printing success", () => {
    const failing: SceneResult[] = [{ title: "x", lines: [], property: "p", holds: false }];
    const rendered = renderWalkthrough(demo, failing);
    expect(rendered).toContain("✘ DOES NOT HOLD: p");
    expect(rendered).toContain("1 propert(ies) did not hold.");
  });

  it("names the stand-ins in the trace, and does not price or time what they do not report", () => {
    const trace = scenes[4]?.lines.join("\n") ?? "";
    expect(trace).toContain("stand-in");
    expect(trace).toContain("unpriced");
    expect(trace).toContain("does not stream");
  });
});
