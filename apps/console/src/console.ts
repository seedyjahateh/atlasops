/**
 * The console: a read-only view over evaluation artefacts.
 *
 * PRD 10 describes it as "a thin read-only UI over answers, traces, and evaluation artefacts". It
 * serves the artefacts, and it **says plainly that it cannot show answers or traces**, because with
 * the `memory` profile the API's audit records and traces live in another process's heap. That is a
 * property of the adapters shipped, not of the architecture — with a shared store the same console
 * would read them — and a console that rendered an empty "Answers" panel instead of saying so would
 * be the more polished way to mislead somebody.
 *
 * It has no dependency on any `@atlasops` package, and that is worth noticing rather than fixing:
 * a read-only view over files on disk genuinely needs nothing from the system it is a view of. The
 * moment it needs one, it will be because it has stopped being read-only.
 *
 * **It renders no untrusted input as markup.** Artefact filenames come from a directory somebody
 * else wrote to, and artefact contents are generated but pass through evaluation data. Everything
 * is escaped and rendered inside a `<pre>`; the console will never be the place a stored payload
 * executes.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

export interface ConsoleConfig {
  readonly port: number;
  readonly evidenceDir: string;
}

/** A flag, taking precedence over the environment. See `apps/api/src/config.ts` for why both. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export function readConsoleConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[] = [],
): ConsoleConfig {
  const rawPort = flag(argv, "port") ?? env.ATLASOPS_CONSOLE_PORT;
  const port = rawPort === undefined || rawPort.length === 0 ? 8081 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `ATLASOPS_CONSOLE_PORT: expected an integer port between 1 and 65535, received "${rawPort ?? ""}"`,
    );
  }

  return {
    port,
    evidenceDir: flag(argv, "evidence") ?? env.ATLASOPS_EVIDENCE_DIR ?? "evidence",
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Artefacts in a directory, by name.
 *
 * A directory that does not exist is an empty list rather than a crash: a console started before
 * the first evaluation run is a normal state, and it should say "no artefacts yet".
 */
export function listArtefacts(directory: string): readonly string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read one artefact, refusing any name that is not a plain file in the directory.
 *
 * The check is on the resolved name rather than on the raw one. A blocklist of `..` is the version
 * of this that gets bypassed; requiring the name to be one the directory listing already produced
 * cannot be.
 */
export function readArtefact(directory: string, name: string): string | null {
  if (!listArtefacts(directory).includes(normalize(name))) return null;
  try {
    return readFileSync(join(directory, normalize(name)), "utf8");
  } catch {
    return null;
  }
}

const STYLE = [
  "body{font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#111}",
  "a{color:#0b5}",
  "pre{background:#f6f6f6;padding:1rem;overflow-x:auto;white-space:pre-wrap;word-break:break-word}",
  "aside{background:#fff8e1;border-left:3px solid #e0a800;padding:.75rem 1rem;margin:1.5rem 0}",
  "h1,h2{font-weight:600}",
].join("");

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>`,
    body,
    "</body></html>",
  ].join("");
}

/** The limitation, rendered where somebody will read it rather than in a README they will not. */
const LIMITATION = [
  "<aside><strong>Answers and traces are not shown.</strong> This build runs the",
  "<code>memory</code> store profile, so the API&#39;s audit records and traces are in another",
  "process&#39;s heap and no shared store exists to read them from. That is a property of the",
  "adapters installed, not of the design — PRD 10 has these components communicating through the",
  "corpus store and the indexes, and a persistent profile is where this panel would come from.",
  "</aside>",
].join(" ");

export function renderIndex(config: ConsoleConfig): string {
  const artefacts = listArtefacts(config.evidenceDir);

  const list =
    artefacts.length === 0
      ? `<p>No artefacts in <code>${escapeHtml(config.evidenceDir)}</code> yet. Run the evaluation runner.</p>`
      : `<ul>${artefacts
          .map(
            (name) =>
              `<li><a href="/artefact?name=${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`,
          )
          .join("")}</ul>`;

  return page(
    "AtlasOps console",
    ["<h1>AtlasOps console</h1>", LIMITATION, "<h2>Evaluation artefacts</h2>", list].join(""),
  );
}

export function renderArtefact(config: ConsoleConfig, name: string): string | null {
  const content = readArtefact(config.evidenceDir, name);
  if (content === null) return null;

  return page(
    name,
    [
      `<p><a href="/">&larr; artefacts</a></p>`,
      `<h1>${escapeHtml(name)}</h1>`,
      `<pre>${escapeHtml(content)}</pre>`,
    ].join(""),
  );
}

export interface ConsoleResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export function handleConsole(config: ConsoleConfig, method: string, url: string): ConsoleResponse {
  // Read-only in the strongest sense: anything that is not a GET is refused before a path is
  // even looked at, so there is no write path to audit.
  if (method !== "GET") {
    return { status: 405, contentType: "text/plain; charset=utf-8", body: "read-only" };
  }

  const [path, query] = url.split("?");
  const html = (body: string): ConsoleResponse => ({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body,
  });

  if (path === "/" || path === "") return html(renderIndex(config));

  if (path === "/artefact") {
    const name = new URLSearchParams(query ?? "").get("name");
    const rendered = name === null ? null : renderArtefact(config, name);
    return rendered === null
      ? { status: 404, contentType: "text/plain; charset=utf-8", body: "no such artefact" }
      : html(rendered);
  }

  return { status: 404, contentType: "text/plain; charset=utf-8", body: "not found" };
}
