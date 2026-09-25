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

import { readFileSync } from "node:fs";

import {
  formatGroupId,
  parsePrincipalId,
  type EmbeddingModelRef,
  type GroupId,
} from "@atlasops/contracts";
import {
  CORPUS_CHUNKING,
  corpusSnapshotOf,
  corpusVersionOracle,
  createAnswerPipeline,
  createIngestionPipeline,
  indexingChunkSink,
} from "@atlasops/composition";
import { inMemoryCorpusStore } from "@atlasops/corpus";
import {
  ARMS,
  BOOTSTRAP_DEFAULTS,
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
  type RelevanceItem,
  type RunReport,
  type Split,
} from "@atlasops/evalkit";
import {
  inMemoryAuditSink,
  parseGroupMap,
  staticGroupResolver,
  type AuditRecord,
} from "@atlasops/governance";
import { PROMPT_VERSION, STAND_IN_MODEL_ID, citingStandIn } from "@atlasops/grounding";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import {
  aclFromManifest,
  filesystemConnector,
  loadAclManifest,
  structureAware,
} from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  deterministicVector,
  fakeReranker,
  inMemoryEmbeddingCache,
  openAiModelSet,
  parseModelChoice,
  realSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
  type Generator,
  type ModelChoice,
} from "@atlasops/model-gateway";
import { RETRIEVAL_DEFAULTS } from "@atlasops/retrieval";
import { UNPRICED_TABLE, systemClock, type PriceTable } from "@atlasops/telemetry";

import { renderRetrievalBySplit, retrievalBySplit } from "./splits.js";

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
  /** A per-path access manifest. Without one, nothing in the corpus is forbidden to anybody. */
  readonly aclManifest: string | null;
  /** A principal-to-groups file, so probes can be run as somebody who must not see a zone. */
  readonly groupMap: string | null;
  /**
   * The reason for reading the held-out split, or null for an ordinary development run.
   *
   * A flag rather than a default, and a reason rather than a boolean. PRD 8.1's held-out split is
   * only held out if the routine loop does not read it, and the routine loop is this command.
   */
  readonly unsealReason: string | null;
  /**
   * Which models answer: the stand-ins, or the OpenAI adapter (P13).
   *
   * The stand-ins are the default so that nothing spends money because a flag was forgotten. The
   * real set refuses to start without `OPENAI_API_KEY`, and every artefact names the set it used.
   */
  readonly models: ModelChoice;
  /**
   * The commit this run was made from.
   *
   * PRD 12 item 2 requires it on the evaluation report. Supplied rather than discovered: shelling
   * out to git from inside a runtime makes the artefact depend on the working tree being a
   * checkout, and a CI job knows its own SHA anyway. Absent is recorded as absent.
   */
  readonly commit: string | null;
}

function optionalPath(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
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
    aclManifest: optionalPath(flag(argv, "acl") ?? env.ATLASOPS_ACL_MANIFEST),
    groupMap: optionalPath(flag(argv, "groups") ?? env.ATLASOPS_GROUP_MAP),
    unsealReason: optionalPath(flag(argv, "final") ?? env.ATLASOPS_UNSEAL_REASON),
    models: modelChoiceFrom(flag(argv, "models") ?? env.ATLASOPS_MODELS),
    commit: flag(argv, "commit") ?? env.ATLASOPS_COMMIT ?? null,
  };
}

function modelChoiceFrom(value: string | undefined): ModelChoice {
  try {
    return parseModelChoice(value);
  } catch (error) {
    throw new ConfigError(
      `ATLASOPS_MODELS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const EMBEDDING = { id: "stand-in-embedder", dimension: 64 };

interface RunModels {
  readonly embedder: Embedder;
  readonly embedding: EmbeddingModelRef;
  readonly generator: Generator;
  readonly prices: PriceTable;
  readonly identifiers: Readonly<Record<string, string>>;
}

/**
 * The models this run answers with.
 *
 * The OpenAI set comes from `model-gateway`, which is the only place a provider may enter; the
 * stand-in generator comes from `grounding`, because it emits the answer structure grounding owns.
 * The reranker is the stand-in in both, and the identifiers say it is unselected.
 */
export function runModels(
  choice: ModelChoice,
  env: Readonly<Record<string, string | undefined>>,
): RunModels {
  if (choice === "openai") {
    try {
      return openAiModelSet(env);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    embedder: standInEmbedder,
    embedding: EMBEDDING,
    generator: citingStandIn(),
    prices: UNPRICED_TABLE,
    identifiers: {
      embedder: EMBEDDING.id,
      reranker: "stand-in-reranker",
      generator: STAND_IN_MODEL_ID,
    },
  };
}

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
  /** The relevance set, so a run that read held-out can break retrieval out by split. */
  readonly relevance: Dataset<RelevanceItem> | null;
  /** One real record the run wrote, so the audit schema is derived rather than described. */
  readonly auditSample: AuditRecord | null;
  readonly commit: string | null;
}

export async function runEvaluationSuite(
  config: RunnerConfig,
  datasets: DatasetsFile,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EvaluationOutcome> {
  // Chosen before anything is built, so a missing key stops the run before it ingests a byte.
  const models = runModels(config.models, env);

  const store = inMemoryCorpusStore();
  const schema = currentSchema(models.embedding);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const group: GroupId = formatGroupId(config.corpusGroup);
  const cache = inMemoryEmbeddingCache();
  const embeddings = createEmbeddingGateway(models.embedder, { sleeper: realSleeper, cache });

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
        // Shared with the inventory tool (P14a). Chunk identifiers are derived from a version and
        // an ordinal, so a different token budget here would produce identifiers no dataset labels.
        strategy: structureAware(CORPUS_CHUNKING),
        ...(config.aclManifest === null
          ? { acl: { readableBy: [group], existence: "visible" } }
          : { aclFor: aclFromManifest(loadAclManifest(config.aclManifest)) }),
        now: () => new Date().toISOString(),
      }),
      chunks: indexingChunkSink(lexical, vector),
      embeddingCache: cache,
    },
    { orderedBy: { id: parsePrincipalId("prn_eval_runner", "runner"), groups: [group] } },
  );

  // One ingestion, then every arm over it. See the file header.
  await ingestion.run();
  const corpusSnapshot = corpusSnapshotOf(store);

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
    generator: models.generator,
    prices: models.prices,
    groups: staticGroupResolver(
      config.groupMap === null
        ? { prn_alice: [group], prn_reader: [group] }
        : parseGroupMap(JSON.parse(readFileSync(config.groupMap, "utf8")), config.groupMap),
    ),
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
        prices: models.prices,
        // PRD 12 item 2: the identifiers of the models that actually answered, by role. A stand-in
        // says so in its name, and an unselected reranker says so in its entry.
        models: models.identifiers,
        ...(config.commit === null ? {} : { commit: config.commit }),
        // Development only unless `--final "<reason>"` says otherwise. The held-out split is only
        // held out if this command — the routine one — does not read it (PRD 8.1).
        ...(config.unsealReason === null
          ? {}
          : {
              splits: ["development", "held-out"] satisfies readonly Split[],
              unsealReason: config.unsealReason,
            }),
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
    relevance: loaded.relevance ?? null,
    auditSample: audit.records()[0] ?? null,
    commit: config.commit,
  };
}

/** The artefact files a run writes, as name and content. Written by `main.ts`. */
/**
 * Everything PRD 12 item 2 names, in one machine-readable record per arm.
 *
 * "Dataset versions and hashes, corpus snapshot hash, commit SHA, model identifiers for embedder,
 * reranker, generator, and judge, prompt versions, run count, seeds, raw per-query result file,
 * and the full metric table." Until P18b, per-query results existed only inside the Markdown, and
 * seeds, run count and the answering prompt's version were recorded nowhere — a verdict reading
 * these artefacts would have had to fail item 2 or overlook the gaps.
 *
 * Only what the run produced is recorded. The seed is the bootstrap's, because it is the only
 * random draw in the pipeline; generation runs at temperature zero and the stand-ins are
 * deterministic, which is recorded as that rather than as a seed nobody used.
 */
export interface RunRecord {
  readonly runId: string;
  readonly arm: string;
  readonly system: string;
  readonly commit: string | null;
  readonly measuredAt: string;
  readonly corpusSnapshot: string;
  readonly snapshotMatchesDatasets: boolean;
  readonly datasets: readonly string[];
  readonly splits: readonly string[];
  readonly models: Readonly<Record<string, string>>;
  readonly promptVersions: { readonly answering: string; readonly judge: string | null };
  readonly runCount: number;
  readonly seeds: { readonly bootstrap: number };
  readonly determinism: string;
  readonly perQueryFile: string;
  readonly perQueryRecords: number;
  readonly metrics: readonly {
    readonly dimension: string;
    readonly metric: string;
    readonly value: number;
    readonly sampleSize: number;
    readonly aggregation: string;
  }[];
  readonly unavailable: readonly { readonly dimension: string; readonly reason: string | null }[];
}

export function runRecordOf(run: RunReport, outcome: EvaluationOutcome): RunRecord {
  return {
    runId: run.runId,
    arm: run.arm,
    system: run.system,
    commit: run.commit,
    measuredAt: run.measuredAt,
    corpusSnapshot: outcome.corpusSnapshot,
    snapshotMatchesDatasets: outcome.snapshotMatchesDatasets,
    datasets: run.datasets,
    splits: run.splits,
    models: run.models,
    promptVersions: {
      answering: PROMPT_VERSION,
      judge: run.judge === null ? null : run.judge.promptVersion,
    },
    runCount: 1,
    seeds: { bootstrap: BOOTSTRAP_DEFAULTS.seed },
    determinism: "generation at temperature 0; stand-in models are deterministic",
    perQueryFile: `run-${run.arm}.queries.jsonl`,
    perQueryRecords: run.perQuery.length,
    metrics: run.table.flatMap((row) =>
      row.metrics.map((metric) => ({
        dimension: row.dimension,
        metric: metric.metric,
        value: metric.value,
        sampleSize: metric.sampleSize,
        aggregation: metric.aggregation,
      })),
    ),
    unavailable: run.table
      .filter((row) => row.unavailable !== null)
      .map((row) => ({ dimension: row.dimension, reason: row.unavailable })),
  };
}

export function artefactsFor(outcome: EvaluationOutcome): readonly {
  readonly name: string;
  readonly content: string;
}[] {
  const files = outcome.runs.flatMap((run) => [
    { name: `run-${run.arm}.md`, content: renderRunReport(run) },
    // PRD 12 item 2's "raw per-query result file". The Markdown report shows these for a reader;
    // this is the file a reviewer or the P18c verdict can load, one record per line.
    {
      name: `run-${run.arm}.queries.jsonl`,
      content: run.perQuery.map((record) => JSON.stringify(record)).join("\n") + "\n",
    },
    {
      name: `run-${run.arm}.json`,
      content: `${JSON.stringify(runRecordOf(run, outcome), null, 2)}\n`,
    },
  ]);

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

  // A final evaluation pools its splits in every figure above; the decision it exists for needs the
  // held-out split on its own. Written only when held-out was read, so a routine run is unchanged.
  const readHeldOut = outcome.runs.some((run) => run.splits.includes("held-out"));
  const bySplit =
    readHeldOut && outcome.relevance !== null
      ? [
          {
            name: "retrieval-by-split.md",
            content: renderRetrievalBySplit(retrievalBySplit(outcome.relevance, outcome.runs), {
              commit: outcome.commit,
              corpusSnapshot: outcome.corpusSnapshot,
            }),
          },
        ]
      : [];

  return [...files, { name: "ablation.md", content: deltas }, ...bySplit];
}
