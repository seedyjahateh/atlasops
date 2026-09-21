/**
 * The evaluation runner: ingest a corpus, run every arm over it, write the artefacts.
 *
 * **It evaluates the same pipeline object the API serves** (ADR 0005). `createAnswerPipeline`
 * returns it, `asAnswerSystem` renames it, and `runEvaluation` measures it. If this file built its
 * own pipeline, an evaluation could pass while the API served something subtly different — which is
 * the failure that makes the whole of PRD 8 worthless.
 *
 * **It ingests before it evaluates, and pins the corpus snapshot it ingested.** A metric computed
 * against a corpus other than the one the dataset was labelled for is not a measurement (PRD 8.1),
 * so the runner refuses when the dataset's snapshot and the corpus it just built disagree — unless
 * told explicitly that the mismatch is expected, which is what the fixture datasets need, because
 * they are labelled against no corpus at all.
 *
 * **Every arm runs over one ingestion.** Re-ingesting between arms would make the ablation a
 * comparison of four corpora, and PRD 8.2 asks for four arms "over the same dataset version".
 */

import { contentHashOf, formatGroupId, parsePrincipalId, type GroupId } from "@atlasops/contracts";
import {
  corpusVersionOracle,
  createAnswerPipeline,
  createIngestionPipeline,
  indexingChunkSink,
} from "@atlasops/composition";
import { inMemoryCorpusStore } from "@atlasops/corpus";
import {
  ARMS,
  compareArms,
  fixtureJudge,
  loadDataset,
  renderGovernanceReport,
  renderRunReport,
  runEvaluation,
  type ArmDelta,
  type ArmName,
  type Dataset,
  type DatasetInput,
  type PermissionProbeItem,
  type RunReport,
} from "@atlasops/evalkit";
import { inMemoryAuditSink, staticGroupResolver, type AuditRecord } from "@atlasops/governance";
import { STAND_IN_MODEL_ID, citingStandIn } from "@atlasops/grounding";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import { filesystemConnector, structureAware } from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  deterministicVector,
  fakeReranker,
  inMemoryEmbeddingCache,
  realSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
} from "@atlasops/model-gateway";
import { RETRIEVAL_DEFAULTS } from "@atlasops/retrieval";
import { UNPRICED_TABLE, systemClock } from "@atlasops/telemetry";

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

export interface RunnerConfig {
  readonly corpusRoot: string;
  readonly datasetsFile: string;
  readonly outputDir: string;
  readonly corpusGroup: string;
  /**
   * Whether a dataset whose corpus snapshot does not match the ingested corpus may still be run.
   *
   * Off by default. It exists because the in-repo fixture datasets are labelled against no corpus
   * — they exercise the metrics — and running them is useful even though every number they
   * produce is about a corpus they were not written for. Anything that reads a report has to be
   * able to see that, so the report records it.
   */
  readonly allowSnapshotMismatch: boolean;
  /**
   * The commit this run was made from.
   *
   * PRD 12 item 2 requires it on the evaluation report. Supplied rather than discovered: shelling
   * out to git from inside a runtime makes the artefact depend on the working tree being a
   * checkout, and a CI job knows its own SHA anyway. Absent is recorded as absent.
   */
  readonly commit: string | null;
}

/** A flag, taking precedence over the environment. See `apps/api/src/config.ts` for why both. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export function readRunnerConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[] = [],
): RunnerConfig {
  const required = (name: string, variable: string, what: string): string => {
    const value = flag(argv, name) ?? env[variable];
    if (value === undefined || value.length === 0) {
      throw new ConfigError(`${variable}: expected ${what}, received nothing`);
    }
    return value;
  };

  const corpusGroup = flag(argv, "group") ?? env.ATLASOPS_CORPUS_GROUP ?? "engineering";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(corpusGroup)) {
    throw new ConfigError("ATLASOPS_CORPUS_GROUP: expected a lower-case identifier");
  }

  return {
    corpusRoot: required("corpus", "ATLASOPS_CORPUS_ROOT", "a directory to ingest"),
    datasetsFile: required("datasets", "ATLASOPS_DATASETS", "a path to a datasets JSON file"),
    outputDir: flag(argv, "evidence") ?? env.ATLASOPS_EVIDENCE_DIR ?? "evidence",
    corpusGroup,
    allowSnapshotMismatch:
      argv.includes("--allow-snapshot-mismatch") || env.ATLASOPS_ALLOW_SNAPSHOT_MISMATCH === "1",
    commit: flag(argv, "commit") ?? env.ATLASOPS_COMMIT ?? null,
  };
}

const EMBEDDING = { id: "stand-in-embedder", dimension: 64 };

const standInEmbedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map((text) => deterministicVector(text, EMBEDDING.dimension)),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

export interface DatasetsFile {
  readonly relevance?: DatasetInput<never>;
  readonly groundedAnswers?: DatasetInput<never>;
  readonly abstention?: DatasetInput<never>;
  readonly permissionProbe?: DatasetInput<never>;
}

export interface EvaluationOutcome {
  readonly runs: readonly RunReport[];
  readonly deltas: readonly ArmDelta[];
  /** The corpus the arms were actually run against. */
  readonly corpusSnapshot: string;
  readonly snapshotMatchesDatasets: boolean;
  /** The probe set, so the governance artefact can be rendered against what actually ran. */
  readonly probes: Dataset<PermissionProbeItem> | null;
  /** One real record the run wrote, so the audit schema is derived rather than described. */
  readonly auditSample: AuditRecord | null;
  readonly commit: string | null;
}

/**
 * The corpus snapshot, as a hash of what was ingested.
 *
 * Derived from the live version of every source in identifier order, so it changes when the corpus
 * changes and not when the crawl order does. It is the value PRD 8.1 wants a dataset pinned to.
 */
function snapshotOf(store: ReturnType<typeof inMemoryCorpusStore>): string {
  const versions = store
    .sources()
    .map((sourceId) => store.liveVersion(sourceId))
    .filter((version) => version !== null)
    .map((version) => `${version.sourceId}\u001f${version.sourceVersionId}`);
  return contentHashOf(versions.join("\n"));
}

export async function runEvaluationSuite(
  config: RunnerConfig,
  datasets: DatasetsFile,
): Promise<EvaluationOutcome> {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const group: GroupId = formatGroupId(config.corpusGroup);
  const cache = inMemoryEmbeddingCache();
  const embeddings = createEmbeddingGateway(standInEmbedder, { sleeper: realSleeper, cache });

  const ingestion = createIngestionPipeline(
    {
      store,
      lexical,
      vector,
      embeddings,
      sleeper: realSleeper,
      clock: systemClock,
      connector: filesystemConnector({
        root: config.corpusRoot,
        strategy: structureAware({ maxTokens: 256, boundaryDepth: 2 }),
        acl: { readableBy: [group], existence: "visible" },
        now: () => new Date().toISOString(),
      }),
      chunks: indexingChunkSink(lexical, vector),
      embeddingCache: cache,
    },
    { orderedBy: { id: parsePrincipalId("prn_eval_runner", "runner"), groups: [group] } },
  );

  // One ingestion, then every arm over it. See the file header.
  await ingestion.run();
  const corpusSnapshot = snapshotOf(store);

  const loaded = {
    relevance: datasets.relevance === undefined ? undefined : loadDataset(datasets.relevance),
    grounded:
      datasets.groundedAnswers === undefined ? undefined : loadDataset(datasets.groundedAnswers),
    abstention: datasets.abstention === undefined ? undefined : loadDataset(datasets.abstention),
    probes:
      datasets.permissionProbe === undefined ? undefined : loadDataset(datasets.permissionProbe),
  };

  const supplied: readonly Dataset<never>[] = [
    loaded.relevance,
    loaded.grounded,
    loaded.abstention,
    loaded.probes,
  ].filter((dataset): dataset is Dataset<never> => dataset !== undefined);

  if (supplied.length === 0) {
    throw new ConfigError(
      `${config.datasetsFile} declares no dataset. A run over nothing produces a report of ` +
        `empty rows, which reads like a clean result.`,
    );
  }

  const snapshotMatchesDatasets = supplied.every(
    (dataset) => dataset.corpusSnapshot === corpusSnapshot,
  );
  if (!snapshotMatchesDatasets && !config.allowSnapshotMismatch) {
    throw new ConfigError(
      `the datasets are labelled against a different corpus than the one just ingested ` +
        `(${corpusSnapshot}). PRD 8.1: re-ingesting the corpus is one of the two most effective ` +
        `ways to fake an improvement, so a metric across the two is not a measurement. Set ` +
        `ATLASOPS_ALLOW_SNAPSHOT_MISMATCH=1 to run anyway; the report will say that you did.`,
    );
  }

  const audit = inMemoryAuditSink();

  const pipeline = createAnswerPipeline({
    store,
    lexical,
    vector,
    embeddings,
    sleeper: realSleeper,
    clock: systemClock,
    reranker: fakeReranker("stand-in-reranker"),
    generator: citingStandIn(),
    groups: staticGroupResolver({ prn_alice: [group], prn_reader: [group] }),
    audit,
    oracle: corpusVersionOracle(store),
    now: () => new Date().toISOString(),
  });

  const runs: RunReport[] = [];
  for (const arm of ARMS) {
    runs.push(
      await runEvaluation({
        system: pipeline.asAnswerSystem(),
        arm,
        baseConfig: RETRIEVAL_DEFAULTS,
        ...loaded,
        judge: fixtureJudge({ modelId: "stand-in-judge", promptVersion: "v1" }),
        prices: UNPRICED_TABLE,
        // PRD 12 item 2. Every one of these is a stand-in, and naming them is how a reader of the
        // artefact can tell that without being told.
        models: {
          embedder: EMBEDDING.id,
          reranker: "stand-in-reranker",
          generator: STAND_IN_MODEL_ID,
        },
        ...(config.commit === null ? {} : { commit: config.commit }),
        now: () => new Date().toISOString(),
      }),
    );
  }

  return {
    runs,
    deltas: compareArms(runs, "fused-with-rerank" satisfies ArmName),
    corpusSnapshot,
    snapshotMatchesDatasets,
    probes: loaded.probes ?? null,
    auditSample: audit.records()[0] ?? null,
    commit: config.commit,
  };
}

/** The artefact files a run writes, as name and content. Written by `main.ts`. */
export function artefactsFor(outcome: EvaluationOutcome): readonly {
  readonly name: string;
  readonly content: string;
}[] {
  const files = outcome.runs.map((run) => ({
    name: `run-${run.arm}.md`,
    content: renderRunReport(run),
  }));

  // PRD 12 item 3. Rendered from the full arm, because that is the configuration a deployment
  // would serve — a leak count from an ablated arm says nothing about the system that ships.
  const full = outcome.runs.find((run) => run.arm === "fused-with-rerank");
  if (outcome.probes !== null && full !== undefined) {
    files.push({
      name: "governance.md",
      content: renderGovernanceReport({
        run: full,
        probes: outcome.probes,
        auditSample: outcome.auditSample,
        commit: outcome.commit,
      }),
    });
  }

  const deltas = [
    "# Ablation deltas",
    "",
    `Corpus snapshot: ${outcome.corpusSnapshot}`,
    "",
    ...(outcome.snapshotMatchesDatasets
      ? []
      : [
          "> **The datasets were not labelled against this corpus.** Every number below is a",
          "> measurement of a corpus these labels were not written for, and is not comparable to",
          "> a run whose snapshot matched. This run was started with",
          "> `ATLASOPS_ALLOW_SNAPSHOT_MISMATCH=1`.",
          "",
        ]),
    "| Metric | Arm | Against | Δ | CI lower | CI upper | Verdict |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...outcome.deltas.map(
      (delta) =>
        `| ${delta.metric} | ${delta.arm} | ${delta.against} | ` +
        `${delta.bootstrap.mean.toFixed(4)} | ${delta.bootstrap.lower.toFixed(4)} | ` +
        `${delta.bootstrap.upper.toFixed(4)} | ${delta.verdict} |`,
    ),
    "",
    "An ablation is not a regression: these deltas say what each arm contributes, and a negative",
    "one is the expected shape of removing a retriever rather than a build failure.",
    "",
  ].join("\n");

  return [...files, { name: "ablation.md", content: deltas }];
}
