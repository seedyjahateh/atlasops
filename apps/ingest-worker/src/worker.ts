/**
 * The ingestion worker: configuration, assembly, and the shape of a run's report.
 *
 * **It exits non-zero when a source failed.** PRD 4.5 requires one bad source to fail alone, and it
 * does — the crawl completes and the other sources are ingested. But a worker that then reported
 * success would make an isolated failure invisible to whatever scheduled it, and "one bad source"
 * becomes "the same bad source, every night, for a year". Isolation is about not losing the good
 * sources; it is not about pretending the bad one did not happen.
 *
 * **Deletions are attributed to the worker's own principal.** The corpus refuses an unattributed
 * deletion, and a worker with no identity would have to invent one at the moment it mattered.
 */

import { formatGroupId, parsePrincipalId, type GroupId } from "@atlasops/contracts";
import {
  createIngestionPipeline,
  indexingChunkSink,
  type IngestionPipeline,
} from "@atlasops/composition";
import { inMemoryCorpusStore } from "@atlasops/corpus";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import {
  aclFromManifest,
  filesystemConnector,
  loadAclManifest,
  structureAware,
  type IngestionReport,
} from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  deterministicVector,
  inMemoryEmbeddingCache,
  realSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
} from "@atlasops/model-gateway";
import { systemClock } from "@atlasops/telemetry";

export const STORE_PROFILES = ["memory"] as const;
export type StoreProfile = (typeof STORE_PROFILES)[number];

export interface WorkerConfig {
  readonly corpusRoot: string;
  readonly profile: StoreProfile;
  readonly corpusGroup: string;
  /** Chunk budget for this connector. PRD 4.3 makes chunking a per-connector decision. */
  readonly maxTokens: number;
  /**
   * A per-path access manifest, for a corpus with zones.
   *
   * Absent means the whole corpus carries `corpusGroup` — fine for a corpus everybody may read,
   * wrong for one a permission probe runs against, because nothing there is forbidden to anybody.
   */
  readonly aclManifest: string | null;
}

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

/** A flag, taking precedence over the environment. See `apps/api/src/config.ts` for why both. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export function readWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[] = [],
): WorkerConfig {
  const corpusRoot = flag(argv, "corpus") ?? env.ATLASOPS_CORPUS_ROOT;
  if (corpusRoot === undefined || corpusRoot.length === 0) {
    throw new ConfigError(
      "ATLASOPS_CORPUS_ROOT: expected a directory to crawl, received nothing. A worker with no " +
        "corpus has nothing to do, and starting one is a way to make a misconfiguration look " +
        "like an empty upstream.",
    );
  }

  const profile = flag(argv, "store") ?? env.ATLASOPS_STORE ?? "memory";
  if (!(STORE_PROFILES as readonly string[]).includes(profile)) {
    throw new ConfigError(
      `ATLASOPS_STORE: "${profile}" is not implemented in this build. Installed: ` +
        `${STORE_PROFILES.join(", ")}. A storage adapter is a change to packages/indexing and a ` +
        `corpus store implementation, not a configuration value.`,
    );
  }

  const corpusGroup = flag(argv, "group") ?? env.ATLASOPS_CORPUS_GROUP ?? "engineering";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(corpusGroup)) {
    throw new ConfigError(`ATLASOPS_CORPUS_GROUP: expected a lower-case identifier`);
  }

  const rawTokens = flag(argv, "chunk-tokens") ?? env.ATLASOPS_CHUNK_TOKENS;
  const maxTokens = rawTokens === undefined || rawTokens.length === 0 ? 256 : Number(rawTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 16) {
    throw new ConfigError(
      `ATLASOPS_CHUNK_TOKENS: expected an integer of at least 16, received "${rawTokens ?? ""}"`,
    );
  }

  const aclManifest = flag(argv, "acl") ?? env.ATLASOPS_ACL_MANIFEST;

  return {
    corpusRoot,
    profile: profile as StoreProfile,
    corpusGroup,
    maxTokens,
    aclManifest: aclManifest === undefined || aclManifest.length === 0 ? null : aclManifest,
  };
}

const EMBEDDING = { id: "stand-in-embedder", dimension: 64 };

/** Named so that every chunk and every trace records that no model produced these vectors. */
const standInEmbedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map((text) => deterministicVector(text, EMBEDDING.dimension)),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

export function createWorker(config: WorkerConfig): IngestionPipeline {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const group: GroupId = formatGroupId(config.corpusGroup);

  return createIngestionPipeline(
    {
      store,
      lexical,
      vector,
      embeddings: createEmbeddingGateway(standInEmbedder, {
        sleeper: realSleeper,
        cache: inMemoryEmbeddingCache(),
      }),
      sleeper: realSleeper,
      clock: systemClock,
      connector: filesystemConnector({
        root: config.corpusRoot,
        strategy: structureAware({ maxTokens: config.maxTokens, boundaryDepth: 2 }),
        // Zones when the corpus declares them, one label when it does not. The manifest resolver
        // refuses a path it does not cover rather than defaulting it readable (PRD 6.1).
        ...(config.aclManifest === null
          ? { acl: { readableBy: [group], existence: "visible" } }
          : { aclFor: aclFromManifest(loadAclManifest(config.aclManifest)) }),
        now: () => new Date().toISOString(),
      }),
      chunks: indexingChunkSink(lexical, vector),
      embeddingCache: inMemoryEmbeddingCache(),
    },
    { orderedBy: { id: parsePrincipalId("prn_ingest_worker", "worker"), groups: [group] } },
  );
}

/** A run's report, as lines. Printed by `main.ts`; returned here so a test can read it. */
export function describeRun(report: IngestionReport): readonly string[] {
  const lines = [
    `connector           ${report.connector}`,
    `observed at         ${report.observedAt}`,
    `added               ${String(report.changes.added.length)}`,
    `modified            ${String(report.changes.modified.length)}`,
    `unchanged           ${String(report.changes.unchanged.length)}`,
    `deleted             ${String(report.changes.deleted.length)}`,
    `tombstoned          ${String(report.changes.tombstoned.length)}`,
    `fetched             ${String(report.fetched)}`,
    `parsed              ${String(report.parsed)}`,
    `model calls         ${String(report.modelCalls)}`,
    `chunks written      ${String(report.chunksWritten)}`,
    `chunks purged       ${String(report.chunksPurged)}`,
    `cache evictions     ${String(report.cacheEvictions)}`,
  ];

  if (report.deletionsWithheld) {
    // The connector said its view was partial. Printing this loudly is the point of the flag:
    // a crawl that half-failed looks exactly like a corpus that shrank.
    lines.push(
      "",
      "deletions were withheld: the connector reported a partial view of its sources, so",
      "absence was not read as deletion (PRD 4.2).",
    );
  }

  if (report.failures.length > 0) {
    lines.push("", `${String(report.failures.length)} source(s) failed:`);
    for (const failure of report.failures) {
      lines.push(`  ${failure.sourceId}: ${failure.error ?? "no reason recorded"}`);
    }
  }

  return lines;
}
