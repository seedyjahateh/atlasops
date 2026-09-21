/**
 * Configuration for the answer API.
 *
 * Parsed once, at startup, into a value the rest of the process uses — so a missing setting is a
 * refusal to start rather than an exception on the first request that happened to need it. Every
 * failure names the variable and what it expected, because the audience for a configuration error
 * is somebody who has just deployed and has no other information.
 *
 * **The profile names an adapter set, and only one is implemented.** `memory` is in-process and
 * loses everything on restart; a persistent profile is where the four components in PRD 10 would
 * actually share state, and none is built. Saying so here, and refusing anything else by name, is
 * better than a configuration that silently falls back to memory and a deployment that quietly
 * forgets its corpus.
 */

export const STORE_PROFILES = ["memory"] as const;
export type StoreProfile = (typeof STORE_PROFILES)[number];

export const GENERATORS = ["stand-in"] as const;
export type GeneratorChoice = (typeof GENERATORS)[number];

export interface ApiConfig {
  readonly port: number;
  readonly profile: StoreProfile;
  readonly generator: GeneratorChoice;
  /**
   * A directory to crawl at startup.
   *
   * Needed because the `memory` profile cannot share a corpus with a separately running ingestion
   * worker — two processes, two heaps. With a persistent profile this would be absent and the
   * worker would own ingestion entirely.
   */
  readonly bootstrapCorpus: string | null;
  /** The group the bootstrap corpus is labelled with, and the group a caller must hold to read it. */
  readonly corpusGroup: string;
}

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

/**
 * A command-line flag, which takes precedence over the environment.
 *
 * Both, rather than one: environment variables are how this is configured in a deployment, and
 * flags are how it is configured from a `package.json` script — setting an environment variable
 * inside one is not portable across shells without a dependency, and a dependency for that is not
 * worth it.
 */
export function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function fail(variable: string, expected: string, received: string | undefined): never {
  throw new ConfigError(
    `${variable}: expected ${expected}, received ${received === undefined ? "nothing" : `"${received}"`}`,
  );
}

function choice<T extends string>(
  variable: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value.length === 0) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;

  // Naming the installed set is the useful part: "unknown profile" leaves somebody guessing
  // whether they mistyped or whether the adapter simply is not built.
  throw new ConfigError(
    `${variable}: "${value}" is not implemented in this build. Installed: ${allowed.join(", ")}. ` +
      `A provider or storage adapter is a change to packages/model-gateway or packages/indexing, ` +
      `not a configuration value.`,
  );
}

export function readApiConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[] = [],
): ApiConfig {
  const rawPort = flag(argv, "port") ?? env.ATLASOPS_PORT;
  const port = rawPort === undefined || rawPort.length === 0 ? 8080 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("ATLASOPS_PORT", "an integer port between 1 and 65535", rawPort);
  }

  const corpusGroup = flag(argv, "group") ?? env.ATLASOPS_CORPUS_GROUP ?? "engineering";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(corpusGroup)) {
    fail("ATLASOPS_CORPUS_GROUP", "a lower-case identifier", corpusGroup);
  }

  const bootstrap = flag(argv, "corpus") ?? env.ATLASOPS_CORPUS_ROOT;

  return {
    port,
    profile: choice(
      "ATLASOPS_STORE",
      flag(argv, "store") ?? env.ATLASOPS_STORE,
      STORE_PROFILES,
      "memory",
    ),
    generator: choice(
      "ATLASOPS_GENERATOR",
      flag(argv, "generator") ?? env.ATLASOPS_GENERATOR,
      GENERATORS,
      "stand-in",
    ),
    bootstrapCorpus: bootstrap === undefined || bootstrap.length === 0 ? null : bootstrap,
    corpusGroup,
  };
}

/** What the process prints at startup, so a running instance can say what it is. */
export function describeApiConfig(config: ApiConfig): readonly string[] {
  return [
    `port                ${String(config.port)}`,
    `store profile       ${config.profile} (in-process; a restart loses the corpus)`,
    `generator           ${config.generator} (no provider adapter is installed)`,
    `bootstrap corpus    ${config.bootstrapCorpus ?? "(none)"}`,
    `corpus group        grp_${config.corpusGroup}`,
  ];
}
