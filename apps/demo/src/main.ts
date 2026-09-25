/**
 * `pnpm demo` — the walkthrough over the example corpus.
 *
 * Stand-ins by default: free, offline and deterministic, and every property still holds. With
 * `--models openai` (and OPENAI_API_KEY in the environment) the answers are real prose and the
 * trace shows real cost and time to first token; a run costs well under a cent.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelChoice } from "@atlasops/model-gateway";

import { buildDemo } from "./demo.js";
import { renderWalkthrough, runWalkthrough } from "./walkthrough.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const demo = await buildDemo({
  corpusRoot: join(ROOT, "examples", "corpus"),
  aclManifest: join(ROOT, "examples", "corpus.acl.json"),
  groupMap: join(ROOT, "examples", "corpus.groups.json"),
  models: parseModelChoice(flag("models") ?? process.env.ATLASOPS_MODELS),
  env: process.env,
});
const scenes = await runWalkthrough(demo);
process.stdout.write(renderWalkthrough(demo, scenes));
process.exitCode = scenes.every((scene) => scene.holds) ? 0 : 1;
