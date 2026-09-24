/**
 * The scripted load run (PRD 9.1, 9.3).
 *
 * Every latency budget in PRD 9.3 names its method, and for the end-to-end one that method is "a
 * scripted load run, fixed workload, stated concurrency". This is that script. It ingests the
 * corpus, then issues the workload against the same answer pipeline the API serves, at a stated
 * concurrency, recording per-request wall time and the stage spans each request produced.
 *
 * **What it measures, and what it cannot.** No provider adapter is wired into these processes, so
 * the models are stand-ins and no request leaves the machine. The latencies below are therefore
 * real measurements of a pipeline whose model calls are local function calls — the retrieval,
 * permission and verification stages are the system that ships, and the generation stage is not.
 * The report says so in those words, and the cost rows report themselves unmeasurable rather than
 * zero, because a stand-in has no price (ADR 0002).
 *
 * **Concurrency is a worker pool, not a burst.** `Promise.all` over the whole workload would be a
 * spike of N, not a sustained level of C, and the p95 of a spike is a queueing artefact rather than
 * a latency. The pool keeps exactly C requests in flight until the schedule is exhausted.
 */

import { readFileSync } from "node:fs";
import { cpus, totalmem, platform, arch } from "node:os";

import {
  CORPUS_CHUNKING,
  corpusSnapshotOf,
  createAnswerPipeline,
  createIngestionPipeline,
  indexingChunkSink,
  corpusVersionOracle,
  type AnswerPipeline,
} from "@atlasops/composition";
import {
  contentHashOf,
  formatGroupId,
  formatRequestId,
  parsePrincipalId,
} from "@atlasops/contracts";
import { inMemoryCorpusStore } from "@atlasops/corpus";
import { inMemoryAuditSink, parseGroupMap, staticGroupResolver } from "@atlasops/governance";
import { citingStandIn } from "@atlasops/grounding";
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
  realSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
} from "@atlasops/model-gateway";
import { inMemoryRetrievalCache } from "@atlasops/retrieval";
import { systemClock, type ReferenceProfile, type StageTiming } from "@atlasops/telemetry";

const EMBEDDING = { id: "stand-in-embedder", dimension: 64 };

/** Named so every artefact records that no model produced these vectors. */
const standInEmbedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map((text) => deterministicVector(text, EMBEDDING.dimension)),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

export interface WorkloadQuery {
  readonly principal: string;
  readonly query: string;
}

export interface Workload {
  readonly id: string;
  readonly queries: readonly WorkloadQuery[];
}

export function parseWorkload(value: unknown, where: string): Workload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const queries = record.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error(
      `${where}.queries must be a non-empty array. A load run over no queries produces a p95 of ` +
        `nothing, and an empty percentile compares as a pass.`,
    );
  }
  return {
    id: typeof record.id === "string" ? record.id : where,
    queries: queries.map((entry, index) => {
      const query = entry as Record<string, unknown>;
      if (typeof query.principal !== "string" || typeof query.query !== "string") {
        throw new Error(`${where}.queries[${String(index)}] needs a principal and a query`);
      }
      return { principal: query.principal, query: query.query };
    }),
  };
}

/** By content, so a changed query changes the profile rather than silently changing the numbers. */
export function workloadHash(workload: Workload): string {
  return contentHashOf(
    workload.queries.map((entry) => `${entry.principal}\u001f${entry.query}`).join("\n"),
  );
}

/**
 * The hardware, described from what the process can see.
 *
 * PRD 9.1 wants stated hardware and the statement is free text on purpose — "8 vCPU, 32 GB,
 * eu-west-1" is more use to a reader than a schema. Read rather than configured, because a
 * hand-written hardware string is the field that goes stale first.
 */
export function describeHardware(): string {
  const model = cpus()[0]?.model.trim() ?? "unknown CPU";
  const gigabytes = Math.round(totalmem() / 1024 ** 3);
  return `${String(cpus().length)} x ${model}, ${String(gigabytes)} GB, ${platform()}/${arch()}, single process`;
}

export interface RequestSample {
  readonly index: number;
  readonly principal: string;
  /** Wall time for the whole call, measured by this harness rather than by the pipeline. */
  readonly totalMs: number;
  /**
   * Whether retrieval was served from its cache.
   *
   * Recorded per request because the first run of this harness put 247 of 260 requests through the
   * cache and reported the resulting p95 as an answer latency, comfortably inside a 3,000 ms
   * budget. Both populations are real and they measure different things; averaging them produces a
   * number that describes neither.
   */
  readonly cacheHit: boolean;
  readonly abstained: boolean;
  readonly stages: readonly StageTiming[];
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LoadRunResult {
  readonly profile: ReferenceProfile;
  readonly samples: readonly RequestSample[];
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Chunks the ingestion wrote, so ingestion cost per 1,000 chunks has a denominator. */
  readonly chunksIngested: number;
  readonly ingestionEmbeddingTokens: number;
  /**
   * How many requests retrieval served from its cache.
   *
   * The embedding cache has no equivalent here: its hits happen inside retrieval, and the gateway
   * reports them to its caller rather than to this harness. PRD 9.2 asks for hit rate per cache and
   * this run can answer for one of the two, so the report says which.
   */
  readonly retrievalCacheHits: number;
}

export interface LoadRunOptions {
  readonly corpusRoot: string;
  readonly aclManifest: string;
  readonly groupMap: string;
  readonly workloadFile: string;
  readonly concurrency: number;
  /** How many times to run the workload through. */
  readonly repeats: number;
  readonly profileId: string;
}

interface Built {
  readonly pipeline: AnswerPipeline;
  readonly corpusSnapshot: string;
  readonly chunksIngested: number;
  readonly ingestionEmbeddingTokens: number;
}

async function build(options: LoadRunOptions): Promise<Built> {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const cache = inMemoryEmbeddingCache();
  const embeddings = createEmbeddingGateway(standInEmbedder, { sleeper: realSleeper, cache });
  const group = formatGroupId("loadrun");

  const ingestion = createIngestionPipeline(
    {
      store,
      lexical,
      vector,
      embeddings,
      sleeper: realSleeper,
      clock: systemClock,
      connector: filesystemConnector({
        root: options.corpusRoot,
        strategy: structureAware(CORPUS_CHUNKING),
        aclFor: aclFromManifest(loadAclManifest(options.aclManifest)),
        now: () => new Date().toISOString(),
      }),
      chunks: indexingChunkSink(lexical, vector),
      embeddingCache: cache,
    },
    { orderedBy: { id: parsePrincipalId("prn_load_runner", "loadrun"), groups: [group] } },
  );

  const report = await ingestion.run();
  if (report.failures.length > 0) {
    throw new Error(
      `the crawl failed on ${String(report.failures.length)} source(s); a load run over a partial ` +
        `corpus measures a corpus nobody can reproduce`,
    );
  }

  const memberships = parseGroupMap(
    JSON.parse(readFileSync(options.groupMap, "utf8")),
    options.groupMap,
  );

  const pipeline = createAnswerPipeline({
    store,
    lexical,
    vector,
    embeddings,
    sleeper: realSleeper,
    clock: systemClock,
    reranker: fakeReranker("stand-in-reranker"),
    generator: citingStandIn(),
    groups: staticGroupResolver(memberships),
    audit: inMemoryAuditSink(),
    oracle: corpusVersionOracle(store),
    retrievalCache: inMemoryRetrievalCache(),
    now: () => new Date().toISOString(),
  });

  return {
    pipeline,
    corpusSnapshot: corpusSnapshotOf(store),
    chunksIngested: report.chunksWritten,
    // Every embedding call the ingestion made, which is the numerator PRD 9.3's ingestion cost
    // budget needs. It is tokens rather than money until a priced model produces them.
    ingestionEmbeddingTokens: report.chunksWritten,
  };
}

/**
 * Runs `task` over every item, keeping exactly `concurrency` in flight.
 *
 * Exported so the claim can be tested rather than asserted in a comment. `Promise.all` over the
 * whole schedule would put N requests in flight at once — a spike, not a sustained level — and the
 * p95 of a spike is a queueing artefact. PRD 9.1 asks for a *stated* concurrency, which has to be
 * the one the run actually held.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, received ${String(concurrency)}`);
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await task(item, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

export async function runLoad(options: LoadRunOptions): Promise<LoadRunResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error(
      `concurrency must be a positive integer, received ${String(options.concurrency)}`,
    );
  }

  const workload = parseWorkload(
    JSON.parse(readFileSync(options.workloadFile, "utf8")),
    options.workloadFile,
  );
  const built = await build(options);

  const schedule: WorkloadQuery[] = [];
  for (let pass = 0; pass < options.repeats; pass += 1) schedule.push(...workload.queries);

  const samples: RequestSample[] = [];
  const startedAt = new Date().toISOString();

  await runPool(schedule, options.concurrency, async (entry, index) => {
    const startedMs = performance.now();
    const outcome = await built.pipeline.answer({
      requestId: formatRequestId(`load_${String(index)}`),
      principalId: parsePrincipalId(entry.principal, "workload.principal"),
      query: entry.query,
    });
    const totalMs = performance.now() - startedMs;

    samples.push({
      index,
      principal: entry.principal,
      totalMs,
      cacheHit: outcome.retrieval.cacheHit,
      abstained: outcome.grounding.answer.abstained,
      // The grounding result's own merged breakdown, which covers the whole request. Adding the
      // retrieval breakdown to it here would count every retrieval stage twice — the audit used to
      // carry a copy of it, and that is exactly the bug this harness found in P15.
      stages: outcome.grounding.timings,
      costUsd: outcome.grounding.audit.costUsd,
      inputTokens: outcome.grounding.audit.inputTokens,
      outputTokens: outcome.grounding.audit.outputTokens,
    });
  });

  const profile: ReferenceProfile = {
    id: options.profileId,
    corpusSnapshot: built.corpusSnapshot as ReferenceProfile["corpusSnapshot"],
    workload: workloadHash(workload) as ReferenceProfile["workload"],
    models: {
      embedder: EMBEDDING.id,
      reranker: "stand-in-reranker",
      generator: "stand-in-not-a-model",
    },
    hardware: describeHardware(),
    concurrency: options.concurrency,
  };

  const ordered = [...samples].sort((a, b) => a.index - b.index);

  return {
    profile,
    samples: ordered,
    startedAt,
    finishedAt: new Date().toISOString(),
    chunksIngested: built.chunksIngested,
    ingestionEmbeddingTokens: built.ingestionEmbeddingTokens,
    retrievalCacheHits: ordered.filter((sample) => sample.cacheHit).length,
  };
}
