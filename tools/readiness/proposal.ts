/**
 * The manifest edit PRD 12 lists, proposed from the artefacts — or no proposal at all.
 *
 * **A proposal, not a promotion.** PRD 12 requires the manifest changes to be "a reviewed edit to
 * `content/projects/RAG-01.json`, not implied by this document". That file lives in the portfolio
 * repository and nothing here writes to it. What this module produces is a file in *this*
 * repository, `docs/promotion/RAG-01.proposed.json`, for a person to read, check against the
 * artefacts, and then apply by hand or not at all. A project that could promote itself would be a
 * project whose proof level means nothing.
 *
 * **Only when all seven items hold.** {@link propose} throws otherwise, so a refusal cannot produce
 * a partial proposal that looks like most of a promotion.
 *
 * **Every number carries a pointer to where it came from.** Each proposed metric's value is copied,
 * unrounded, from a published artefact, and `provenance` records the file and the JSON pointer. The
 * readiness test resolves every pointer and compares, which is how "no number is promoted that its
 * artefact does not contain" is enforced rather than promised. Rounding happens on the site, where
 * it is presentation; rounding here would promote a number no artefact contains.
 *
 * **Every metric the artefacts contain is accounted for.** A row is either proposed or listed in
 * `excluded` with its reason — a stand-in measured it, the cache measured it, a judge nobody chose
 * scored it. A metric that appears in neither would be a decision nobody can see, so an unmapped
 * row is excluded *by name* rather than silently dropped.
 */

import {
  ARMS,
  isStandIn,
  loadRunRecord,
  PATHS,
  runRecords,
  servedArmOf,
  type Verdict,
} from "./verdict.js";
import { isRecord, type RepositoryView } from "./view.js";

export const PROPOSAL_PATH = "docs/promotion/RAG-01.proposed.json";
export const MANIFEST_TARGET = "content/projects/RAG-01.json, in the portfolio repository";
export const REPOSITORY_URL = "https://github.com/seedyjahateh/atlasops";

const PRD_PATH = "docs/prd/RAG-01-atlasops.md";

/** Links resolve on `main`; the reviewer pins them to the reviewed commit (see `forTheReviewer`). */
function blob(path: string): string {
  return `${REPOSITORY_URL}/blob/main/${path}`;
}

export interface ProposedMetric {
  readonly id: string;
  readonly category: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly direction: "higher-is-better" | "lower-is-better";
  readonly environment: string;
  readonly sampleSize: number;
  readonly synthetic: true;
  readonly measuredAt: string;
  readonly evidenceUrl: string;
}

export interface ProposedEvidence {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly primary: boolean;
  readonly verifiedAt: string | null;
  readonly external: false;
}

export interface Provenance {
  readonly file: string;
  readonly pointer: string;
}

export interface Proposal {
  readonly $comment: string;
  readonly target: string;
  readonly generatedBy: string;
  readonly basis: string;
  readonly changes: {
    readonly status: "in-progress" | "complete";
    readonly proofLevel: "measured";
    readonly content: { readonly problem: string; readonly limitations: readonly string[] };
    readonly stack: Readonly<Record<StackGroup, readonly string[]>>;
    readonly metrics: readonly ProposedMetric[];
    readonly evidence: readonly ProposedEvidence[];
    readonly dates: { readonly started: string | null; readonly lastVerified: string };
    readonly integrity: { readonly reviewedBy: null; readonly reviewedAt: null };
  };
  readonly provenance: {
    readonly metrics: Readonly<Record<string, Provenance>>;
    readonly lastVerified: Provenance;
    readonly problem: Provenance;
    readonly limitations: Provenance;
  };
  readonly excluded: readonly { readonly what: string; readonly reason: string }[];
  readonly forTheReviewer: readonly string[];
}

/** What only the repository's history knows. The CLI reads it from git and records it. */
export interface HistoryFacts {
  /** The date of the repository's first commit, `YYYY-MM-DD`, or `null` if it could not be read. */
  readonly started: string | null;
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

interface MetricShape {
  readonly id: string;
  readonly category: string;
  readonly label: string;
  readonly unit: string;
  readonly direction: "higher-is-better" | "lower-is-better";
}

/**
 * The served arm's rows that are proposed. Categories and units are terms from the portfolio's
 * `metrics.v1` vocabulary, whose categories constrain units by dimension (MET-UNIT-001).
 */
const EVALUATION_METRICS: Readonly<Record<string, MetricShape>> = {
  "recall@10": {
    id: "retrieval-recall-at-10",
    category: "quality",
    label: "Retrieval recall@10, served configuration",
    unit: "ratio",
    direction: "higher-is-better",
  },
  "nDCG@10": {
    id: "retrieval-ndcg-at-10",
    category: "quality",
    label: "Retrieval nDCG@10, served configuration",
    unit: "ratio",
    direction: "higher-is-better",
  },
  MRR: {
    id: "retrieval-mrr",
    category: "quality",
    label: "Retrieval mean reciprocal rank, served configuration",
    unit: "ratio",
    direction: "higher-is-better",
  },
  "citation-precision": {
    id: "citation-precision",
    category: "quality",
    label: "Citation precision",
    unit: "ratio",
    direction: "higher-is-better",
  },
  "citation-recall": {
    id: "citation-recall",
    category: "quality",
    label: "Citation recall",
    unit: "ratio",
    direction: "higher-is-better",
  },
  "span-validity": {
    id: "citation-span-validity",
    category: "quality",
    label: "Cited spans that resolve to the cited source text",
    unit: "ratio",
    direction: "higher-is-better",
  },
  "correct-abstention": {
    id: "correct-abstention",
    category: "quality",
    label: "Correct abstention on questions the corpus cannot answer",
    unit: "ratio",
    direction: "higher-is-better",
  },
  "over-abstention": {
    id: "over-abstention",
    category: "quality",
    label: "Abstention on questions the corpus can answer",
    unit: "ratio",
    direction: "lower-is-better",
  },
  "leak-count": {
    id: "permission-leak-count",
    category: "reliability",
    label: "Permission leaks over the probe set",
    unit: "count",
    direction: "lower-is-better",
  },
  "existence-disclosure": {
    id: "existence-disclosure-count",
    category: "reliability",
    label: "Existence disclosures over the probe set",
    unit: "count",
    direction: "lower-is-better",
  },
};

/** Why a served-arm row that is not proposed is not, decided by rule so that a new row surfaces. */
function evaluationExclusion(row: Record<string, unknown>, judge: unknown): string {
  const metric = String(row.metric);
  if (row.dimension === "Groundedness" && isStandIn(judge)) {
    return `scored by \`${String(judge)}\`, a stand-in judge: PRD 8.3 does not let a judged metric gate a release alone, and a stand-in's score is not evidence of groundedness at all`;
  }
  if (metric.startsWith("contribution:")) {
    return "a diagnostic of how fusion weighed the retrievers, not a property of the answers";
  }
  if (row.dimension === "Cost and latency") {
    return "counts generation only; the load run's cost per answered query is the whole-request figure and is proposed instead";
  }
  return "no manifest mapping is defined for this row; it was left out rather than guessed at";
}

interface BudgetShape extends MetricShape {
  /** Why the budget is not proposed on this record, or `null` when it is. */
  readonly exclude?: (record: Record<string, unknown>) => string | null;
}

function cacheShare(record: Record<string, unknown>): string {
  const rate = record.retrievalCacheHitRate;
  return typeof rate === "number" ? `${String(Math.round(rate * 100))}%` : "an unrecorded share";
}

const BUDGET_METRICS: Readonly<Record<string, BudgetShape>> = {
  "ANSWER-LATENCY-P95": {
    id: "answer-latency-p95",
    category: "latency",
    label: "End-to-end answer latency p95, all requests",
    unit: "ms",
    direction: "lower-is-better",
  },
  "TIME-TO-FIRST-TOKEN-P95": {
    id: "time-to-first-token-p95",
    category: "latency",
    // "Model": nothing reaches the caller at the first token; the answer is released whole after
    // verification (PRD 7.2, ADR 0012). The label must not suggest a user saw it.
    label: "Time to the model's first token p95, from the start of the request",
    unit: "ms",
    direction: "lower-is-better",
  },
  "RETRIEVAL-STAGE-P95": {
    id: "retrieval-stage-latency-p95",
    category: "latency",
    label: "Retrieval stage latency p95, both retrievers and fusion",
    unit: "ms",
    direction: "lower-is-better",
  },
  "RERANK-STAGE-P95": {
    id: "rerank-stage-latency-p95",
    category: "latency",
    label: "Rerank stage latency p95",
    unit: "ms",
    direction: "lower-is-better",
    exclude: (record) => {
      const profile = isRecord(record.profile) ? record.profile : {};
      const models = isRecord(profile.models) ? profile.models : {};
      return isStandIn(models.reranker)
        ? `measures \`${String(models.reranker)}\`, a local function, not a rerank model`
        : null;
    },
  },
  "PERMISSION-P95": {
    id: "permission-latency-p95",
    category: "latency",
    label: "Permission resolution and predicate compilation latency p95",
    unit: "ms",
    direction: "lower-is-better",
  },
  "VERIFICATION-P95": {
    id: "verification-latency-p95",
    category: "latency",
    label: "Citation verification latency p95",
    unit: "ms",
    direction: "lower-is-better",
  },
  "COST-PER-ANSWER-P50": {
    id: "cost-per-answer-p50",
    category: "cost",
    label: "Cost per answered query p50, excluding reranking",
    unit: "usd",
    direction: "lower-is-better",
  },
  "COST-PER-ANSWER-P95": {
    id: "cost-per-answer-p95",
    category: "cost",
    label: "Cost per answered query p95, excluding reranking",
    unit: "usd",
    direction: "lower-is-better",
  },
  "INGESTION-COST-PER-1K-CHUNKS": {
    id: "ingestion-cost-per-1k-chunks",
    category: "cost",
    label: "Ingestion embedding cost per 1,000 chunks",
    unit: "usd-per-1k",
    direction: "lower-is-better",
  },
  "RETRIEVAL-ONLY-COST": {
    id: "retrieval-only-cost",
    category: "cost",
    label: "Cost of a retrieval-only query",
    unit: "usd",
    direction: "lower-is-better",
    exclude: (record) => {
      const rate = record.retrievalCacheHitRate;
      return typeof rate === "number" && rate > 0.5
        ? `${cacheShare(record)} of requests were served from the retrieval cache and never embedded a query, so the figure measures the cache rather than a retrieval`
        : null;
    },
  },
};

/** The latency row proposed beside the headline figure, because the headline is mostly cache. */
const CACHE_MISS_STAGE = "end-to-end (retrieval cache miss)";

function shortHash(hash: unknown): string {
  return typeof hash === "string" ? hash.slice(0, "sha256:".length + 12) : "an unrecorded hash";
}

function checkedEnvironment(environment: string): string {
  // The portfolio schema bounds `environment` at 20 to 400 characters. A string outside that
  // would be rejected at the reviewed edit; failing here names the cause instead.
  if (environment.length < 20 || environment.length > 400) {
    throw new Error(
      `readiness: an environment string is ${String(environment.length)} characters, outside 20-400`,
    );
  }
  return environment;
}

function evaluationEnvironment(record: Record<string, unknown>): string {
  const models = isRecord(record.models) ? record.models : {};
  const datasets = Array.isArray(record.datasets)
    ? record.datasets.map((entry) => String(entry).split(" ")[0]).join(", ")
    : "unrecorded datasets";
  const splits = Array.isArray(record.splits) ? record.splits.join("+") : "unrecorded";
  const reranker = String(models.reranker).split(" ")[0] ?? "";
  return checkedEnvironment(
    `Evaluation, ${splits} split: ${datasets}; corpus ${shortHash(record.corpusSnapshot)}; ` +
      `embedder ${String(models.embedder)}, generator ${String(models.generator)}, reranker ${reranker}; ` +
      `${String(record.runCount)} run at commit ${String(record.commit)}`,
  );
}

function loadEnvironment(record: Record<string, unknown>): string {
  const profile = isRecord(record.profile) ? record.profile : {};
  const models = isRecord(profile.models) ? profile.models : {};
  const reranker = String(models.reranker).split(" ")[0] ?? "";
  return checkedEnvironment(
    `Load profile ${String(profile.id)}: ${String(profile.hardware)}; concurrency ` +
      `${String(profile.concurrency)}; ${String(record.requests)} requests over workload ` +
      `${shortHash(profile.workload)}; embedder ${String(models.embedder)}, generator ` +
      `${String(models.generator)}, reranker ${reranker}; ${cacheShare(record)} retrieval-cache hits`,
  );
}

function dateOf(timestamp: unknown): string | null {
  return typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T/.test(timestamp)
    ? timestamp.slice(0, 10)
    : null;
}

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------

/** Markdown to plain text, for fields the site renders as text. */
export function plainText(markdown: string): string {
  return markdown
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"(])/);
}

/**
 * Leading sentences of `text`, as many as fit in `limit` characters. A sentence that ends in a
 * colon introduces a list the caller has split out, so it is not kept at the end — standing alone
 * it would promise items that do not follow.
 */
function leadingSentences(text: string, limit: number): { kept: string; dropped: string[] } {
  const all = sentences(text);
  const kept: string[] = [];
  for (const sentence of all) {
    if ([...kept, sentence].join(" ").length > limit) break;
    kept.push(sentence);
  }
  while (kept.length > 1 && kept[kept.length - 1]?.endsWith(":") === true) kept.pop();
  return { kept: kept.join(" "), dropped: all.slice(kept.length) };
}

/**
 * PRD section 1's first paragraph that is about the problem — the one after the paragraph about
 * the manifest field itself. PRD 12: "`content.problem` populated from section 1".
 */
function problemStatement(view: RepositoryView): { text: string; dropped: readonly string[] } {
  const prd = view.read(PRD_PATH) ?? "";
  const section = /^## 1\. [^\n]*\n([\s\S]*?)(?=^### |^## )/m.exec(prd)?.[1] ?? "";
  const paragraphs = section
    .split(/\n\s*\n/)
    .map((paragraph) => plainText(paragraph))
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith("The manifest's"));
  const first = paragraphs[0] ?? "";
  if (first.length <= 600) return { text: first, dropped: [] };
  const { kept, dropped } = leadingSentences(first, 600);
  return { text: kept, dropped };
}

/**
 * The limitations list's entries, as manifest strings: every paragraph that leads with a bold
 * statement in the two sections that list limitations, and the bullets that follow such a
 * paragraph. The third section — scope boundaries — is choices rather than limitations, and says
 * so; it is not proposed.
 */
export function limitationEntries(text: string): string[] {
  const sections = ["## The four PRD 12 names", "## What this build actually has"];
  const entries: string[] = [];
  for (const heading of sections) {
    const start = text.indexOf(heading);
    if (start === -1) continue;
    const rest = text.slice(start + heading.length);
    const end = rest.search(/^---$|^## /m);
    const body = end === -1 ? rest : rest.slice(0, end);
    // Blocks are paragraphs; a list is split into one block per item.
    const blocks = body
      .split(/\n\s*\n/)
      .flatMap((block) => (block.trimStart().startsWith("- ") ? block.split(/\n(?=- )/) : [block]));
    let afterBoldParagraph = false;
    for (const raw of blocks) {
      const block = raw.trim();
      if (block.startsWith("**")) {
        afterBoldParagraph = true;
      } else if (block.startsWith("- **")) {
        if (!afterBoldParagraph) continue;
      } else {
        afterBoldParagraph = false;
        continue;
      }
      const plain = plainText(block.replace(/^- /, ""));
      const { kept } = leadingSentences(plain, 400);
      const lead = /^\*\*([^*]+)\*\*/.exec(block.replace(/^- /, ""))?.[1];
      const entry = kept.length >= 10 ? kept : plainText(lead ?? "");
      if (entry.length >= 10 && entry.length <= 400) entries.push(entry);
    }
  }
  return entries;
}

/** Whether the limitations list records a PRD requirement as unimplemented. */
function unimplementedRequirement(text: string): string | null {
  const start = text.indexOf("## What this build actually has");
  if (start === -1) return null;
  const section = text.slice(start);
  const end = section.search(/^---$/m);
  const body = end === -1 ? section : section.slice(0, end);
  const sentence = sentences(plainText(body)).find((candidate) =>
    /\bis not implemented\b/.test(candidate),
  );
  return sentence ?? null;
}

// ---------------------------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------------------------

type StackGroup = "languages" | "frameworks" | "data" | "infrastructure" | "ai" | "testing";

/**
 * Development dependencies that map to a term in the portfolio's `technology.v1` vocabulary.
 * Anything used that has no term here is listed for the reviewer rather than invented: adding a
 * term is a reviewed taxonomy change (TAX-UNKNOWN-001), not a manifest edit.
 */
const TECHNOLOGY_TERMS: Readonly<Record<string, readonly [StackGroup, string]>> = {
  typescript: ["languages", "typescript"],
  vitest: ["testing", "vitest"],
};

function stackOf(view: RepositoryView): Record<StackGroup, string[]> {
  const stack: Record<StackGroup, string[]> = {
    languages: [],
    frameworks: [],
    data: [],
    infrastructure: [],
    ai: [],
    testing: [],
  };
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(view.read(PATHS.packageJson) ?? "null") as unknown;
  } catch {
    manifest = null;
  }
  const dependencies =
    isRecord(manifest) && isRecord(manifest.devDependencies) ? manifest.devDependencies : {};
  for (const name of Object.keys(dependencies).sort()) {
    const term = TECHNOLOGY_TERMS[name];
    if (term !== undefined) stack[term[0]].push(term[1]);
  }
  if (view.read(".github/workflows/ci.yml") !== null) stack.infrastructure.push("github-actions");
  return stack;
}

// ---------------------------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------------------------

export class RefusedError extends Error {
  readonly unmet: readonly number[];

  constructor(unmet: readonly number[]) {
    super(
      `readiness: PRD 12 item(s) ${unmet.join(", ")} are not met, so no manifest edit is proposed. ` +
        "PRD 12: until every item is present, the manifest stays at `code`.",
    );
    this.name = "RefusedError";
    this.unmet = unmet;
  }
}

export function propose(view: RepositoryView, verdict: Verdict, history: HistoryFacts): Proposal {
  if (!verdict.allMet) {
    throw new RefusedError(verdict.items.filter((item) => !item.met).map((item) => item.item));
  }
  const records = runRecords(view);
  const servedArm = servedArmOf(records);
  const served = servedArm === null ? null : records.get(servedArm);
  const load = loadRunRecord(view);
  if (servedArm === null || served === null || served === undefined || load === null) {
    // Unreachable when the verdict holds, since items 2 and 4 read the same files.
    throw new Error("readiness: the verdict holds but an artefact it read is missing");
  }

  const metrics: ProposedMetric[] = [];
  const provenance: Record<string, Provenance> = {};
  const excluded: { what: string; reason: string }[] = [];
  const servedJson = PATHS.runJson(servedArm);
  const servedModels = isRecord(served.models) ? served.models : {};
  const evaluationEnv = evaluationEnvironment(served);
  const evaluatedAt = String(served.measuredAt);

  const rows = Array.isArray(served.metrics) ? served.metrics.filter(isRecord) : [];
  rows.forEach((row, index) => {
    const shape = EVALUATION_METRICS[String(row.metric)];
    if (shape === undefined) {
      excluded.push({
        what: `${String(row.metric)} (${servedJson})`,
        reason: evaluationExclusion(row, servedModels.judge),
      });
      return;
    }
    metrics.push({
      id: shape.id,
      category: shape.category,
      label: shape.label,
      value: Number(row.value),
      unit: shape.unit,
      direction: shape.direction,
      environment: evaluationEnv,
      sampleSize: Number(row.sampleSize),
      synthetic: true,
      measuredAt: evaluatedAt,
      evidenceUrl: blob(servedJson),
    });
    provenance[shape.id] = { file: servedJson, pointer: `/metrics/${String(index)}/value` };
  });
  for (const arm of ARMS.filter((arm) => arm !== servedArm)) {
    excluded.push({
      what: `every metric of the \`${arm}\` arm (${PATHS.runJson(arm)})`,
      reason:
        "an ablation arm is evidence about the served configuration, not a description of it; it is linked through the ablation report",
    });
  }

  const loadEnv = loadEnvironment(load);
  const loadedAt = String(load.finishedAt);
  const budgets = Array.isArray(load.budgets) ? load.budgets.filter(isRecord) : [];
  budgets.forEach((budget, index) => {
    const id = String(budget.id);
    const shape = BUDGET_METRICS[id];
    const reason =
      budget.value === null
        ? `unmeasured: ${String(budget.unmeasured)}`
        : shape === undefined
          ? "no manifest mapping is defined for this budget; it was left out rather than guessed at"
          : (shape.exclude?.(load) ?? null);
    if (reason !== null || shape === undefined) {
      excluded.push({ what: `${id} (${PATHS.loadRun})`, reason: reason ?? "unmapped" });
      return;
    }
    metrics.push({
      id: shape.id,
      category: shape.category,
      label:
        id === "ANSWER-LATENCY-P95"
          ? `${shape.label} (${cacheShare(load)} retrieval-cache hits)`
          : shape.label,
      value: Number(budget.value),
      unit: shape.unit,
      direction: shape.direction,
      environment: loadEnv,
      sampleSize: Number(budget.sampleSize),
      synthetic: true,
      measuredAt: loadedAt,
      evidenceUrl: blob(PATHS.loadRun),
    });
    provenance[shape.id] = { file: PATHS.loadRun, pointer: `/budgets/${String(index)}/value` };
  });

  const latency = Array.isArray(load.latency) ? load.latency.filter(isRecord) : [];
  const missIndex = latency.findIndex((row) => row.stage === CACHE_MISS_STAGE);
  const miss = latency[missIndex];
  if (miss !== undefined && typeof miss.p95 === "number") {
    metrics.push({
      id: "answer-latency-p95-cache-miss",
      category: "latency",
      label: `End-to-end answer latency p95, retrieval-cache misses only${miss.p95IsMaximum === true ? " (the slowest sample)" : ""}`,
      value: miss.p95,
      unit: "ms",
      direction: "lower-is-better",
      environment: loadEnv,
      sampleSize: Number(miss.samples),
      synthetic: true,
      measuredAt: loadedAt,
      evidenceUrl: blob(PATHS.loadRun),
    });
    provenance["answer-latency-p95-cache-miss"] = {
      file: PATHS.loadRun,
      pointer: `/latency/${String(missIndex)}/p95`,
    };
  }

  const boundaries = view.read(PATHS.boundaries) ?? "";
  const evidence: ProposedEvidence[] = [
    {
      id: "evaluation-served-configuration",
      type: "evaluation",
      title: `Evaluation report for the served configuration, the ${servedArm} arm`,
      url: blob(PATHS.runReport(servedArm)),
      primary: true,
      verifiedAt: dateOf(evaluatedAt),
      external: false,
    },
    {
      id: "evaluation-ablation",
      type: "evaluation",
      title: "Ablation across the four retrieval arms",
      url: blob(PATHS.ablation),
      primary: false,
      verifiedAt: dateOf(evaluatedAt),
      external: false,
    },
    {
      id: "governance-report",
      type: "evaluation",
      title: "Governance report: permission probes, leak count and the prompt-injection subset",
      url: blob(PATHS.governance),
      primary: false,
      verifiedAt: dateOf(evaluatedAt),
      external: false,
    },
    {
      id: "cost-and-latency-report",
      type: "benchmark",
      title: "Cost and latency report from a scripted load run, with the stage breakdown",
      url: blob(PATHS.costAndLatency),
      primary: false,
      verifiedAt: dateOf(loadedAt),
      external: false,
    },
    {
      id: "load-run-span-export",
      type: "benchmark",
      title: "Raw span export of the load run, one trace per request",
      url: blob(PATHS.spans),
      primary: false,
      verifiedAt: dateOf(loadedAt),
      external: false,
    },
    {
      id: "boundary-enforcement",
      type: "test-report",
      title: "Boundary enforcement: the check result and the generated module graph",
      url: blob(PATHS.boundaries),
      primary: false,
      verifiedAt: dateOf(/^- \*\*Generated:\*\* (\S+)$/m.exec(boundaries)?.[1]),
      external: false,
    },
    {
      id: "threat-model",
      type: "threat-model",
      title: "Threat model, each mitigation mapped to the test that exercises it",
      url: blob(PATHS.threatModel),
      primary: false,
      verifiedAt: null,
      external: false,
    },
  ];

  const limitationsText = view.read(PATHS.limitations) ?? "";
  const problem = problemStatement(view);
  const unimplemented = unimplementedRequirement(limitationsText);
  const lastVerified = dateOf(evaluatedAt);
  if (lastVerified === null)
    throw new Error("readiness: the served arm records no measurement date");

  const notes: string[] = [
    "Nothing in this file has been applied. It is a proposal for a reviewed edit to the portfolio manifest, which this repository never writes.",
    "Every URL points at `main`. Pin each to the commit you review, so that the evidence cannot change under the manifest after it is promoted.",
    "`integrity.reviewedBy` and `integrity.reviewedAt` are left null on purpose: they record a person's review, and a generator cannot perform one.",
  ];
  if (unimplemented !== null) {
    notes.push(
      `\`status\` is \`in-progress\` rather than \`complete\` because the limitations list records a PRD requirement as unimplemented: "${unimplemented}"`,
    );
  }
  const ndcg = (arm: string) => {
    const record = records.get(arm);
    const value =
      record === null || record === undefined ? undefined : metricRowValue(record, "nDCG@10");
    return typeof value === "number" ? value : null;
  };
  const servedNdcg = ndcg(servedArm);
  const better = ARMS.filter((arm) => arm !== servedArm).filter((arm) => {
    const value = ndcg(arm);
    return value !== null && servedNdcg !== null && value > servedNdcg;
  });
  if (better.length > 0 && servedNdcg !== null) {
    notes.push(
      `The served configuration is not the best-ranking arm: its nDCG@10 is ${servedNdcg.toFixed(4)}, below ${better
        .map((arm) => `${arm} (${(ndcg(arm) ?? 0).toFixed(4)})`)
        .join(
          " and ",
        )}. The proposed retrieval metrics describe what is served; changing what is served is a decision to confirm on the held-out split before promotion, not after.`,
    );
  }
  const splits = Array.isArray(served.splits) ? served.splits.map(String) : [];
  if (!splits.includes("held-out")) {
    notes.push(
      `The evaluation used the ${splits.join(" and ")} split only; no number here comes from the held-out split. Where a held-out run was published, it is linked from the limitations list rather than promoted.`,
    );
  }
  // A budget over its target is promoted as measured, with the breach stated beside it: a reviewer
  // should not have to open the load record to learn that a proposed number fails its budget.
  const loadBudgets = Array.isArray(load.budgets) ? load.budgets.filter(isRecord) : [];
  for (const budget of loadBudgets.filter((row) => row.within === false)) {
    notes.push(
      `${String(budget.id)} is over its PRD 9.3 budget: ${String(budget.value)} ${String(budget.unit)} against ${String(budget.target)}. It is proposed as measured, not as met. Whether the breach was accepted, by whom and why is in docs/measurements/accepted-breaches.json.`,
    );
  }
  if (problem.dropped.length > 0) {
    notes.push(
      `\`content.problem\` is the leading sentences of PRD section 1's first paragraph, cut at a sentence boundary to fit the schema's 600 characters rather than rewritten. Left out: "${problem.dropped.join(" ")}" — decide whether the field needs it more than what precedes it.`,
    );
  }
  notes.push(
    `The stack lists only terms the portfolio vocabulary has. The models used — ${String(servedModels.embedder)} and ${String(servedModels.generator)}, over HTTP without an SDK (ADR 0006) — have no term in \`technology.v1\`; adding one is a reviewed taxonomy change, not part of this edit.`,
  );

  return {
    $comment:
      "Generated by `pnpm readiness` from the published artefacts. A proposal for review, not a manifest: `provenance`, `excluded` and `forTheReviewer` are for the reviewer and are not manifest fields.",
    target: MANIFEST_TARGET,
    generatedBy: "tools/readiness",
    basis:
      "All seven PRD 12 items are met, each decided from its artefact; see docs/promotion-readiness.md.",
    changes: {
      status: unimplemented === null ? "complete" : "in-progress",
      proofLevel: "measured",
      content: { problem: problem.text, limitations: limitationEntries(limitationsText) },
      stack: stackOf(view),
      metrics,
      evidence,
      dates: { started: history.started, lastVerified },
      integrity: { reviewedBy: null, reviewedAt: null },
    },
    provenance: {
      metrics: provenance,
      lastVerified: { file: servedJson, pointer: "/measuredAt" },
      problem: {
        file: PRD_PATH,
        pointer: "section 1, first paragraph after the note on the manifest field",
      },
      limitations: {
        file: PATHS.limitations,
        pointer: "bold-led entries of its first two sections",
      },
    },
    excluded,
    forTheReviewer: notes,
  };
}

function metricRowValue(record: Record<string, unknown>, metric: string): unknown {
  const rows = Array.isArray(record.metrics) ? record.metrics.filter(isRecord) : [];
  return rows.find((row) => row.metric === metric)?.value;
}

/** The committed form: two-space JSON and a trailing newline, which is what the check compares. */
export function serialiseProposal(proposal: Proposal): string {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}
