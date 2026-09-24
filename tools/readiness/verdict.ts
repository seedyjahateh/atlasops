/**
 * PRD 12's seven promotion items, each decided from the artefact that is supposed to satisfy it.
 *
 * **Why a generator rather than a paragraph.** Until P18c `docs/promotion-readiness.md` was written
 * by hand, and it went stale the way hand-written verdicts do: item 5 said "not met" for a phase
 * after the artefact said "met", and item 4's section still described a run against stand-ins
 * after the real run was published. A verdict somebody edits is an opinion about the evidence.
 * This one is a function of it, so the only way to change it is to change an artefact — and
 * `pnpm readiness:check` fails the build when the committed document disagrees with the function.
 *
 * **What a check here can and cannot establish.** Each check reads a published file and asks
 * whether it contains what PRD 12 names: fields present, counts consistent across files, references
 * that resolve. That is the whole of what an artefact can prove about itself. It cannot prove the
 * run happened the way the artefact says; the commit, the corpus hash and the raw per-query and
 * per-span files are what let somebody else check that, and the checks require all three.
 *
 * **Every check fails closed.** A missing file, an unparseable file, or a file whose shape the
 * check does not recognise is a finding that does not hold. A generator whose format changed
 * therefore turns an item unmet rather than silently passing it, and the fix is to update the
 * check in the same change as the format — which a reviewer then sees.
 */

import { isRecord, jsonLines, nonEmptyString, parseJson, type RepositoryView } from "./view.js";

export interface Finding {
  readonly holds: boolean;
  readonly text: string;
}

export interface ItemVerdict {
  /** PRD 12's numbering, 1 to 7. */
  readonly item: number;
  readonly title: string;
  readonly met: boolean;
  /** The files the verdict was decided from. */
  readonly sources: readonly string[];
  readonly findings: readonly Finding[];
}

export interface Verdict {
  readonly items: readonly ItemVerdict[];
  readonly allMet: boolean;
}

/** PRD 8.2's ablation arms. The served configuration is the last. */
export const ARMS = ["dense-only", "lexical-only", "fused-no-rerank", "fused-with-rerank"] as const;
export const SERVED_ARM = "fused-with-rerank";

export const PATHS = {
  packageJson: "package.json",
  appsReadme: "apps/README.md",
  inventory: "examples/corpus.inventory.json",
  evidenceDirectory: "docs/evidence",
  runJson: (arm: string) => `docs/evidence/run-${arm}.json`,
  runReport: (arm: string) => `docs/evidence/run-${arm}.md`,
  ablation: "docs/evidence/ablation.md",
  governance: "docs/evidence/governance.md",
  costAndLatency: "docs/evidence/cost-and-latency.md",
  boundaries: "docs/evidence/boundaries.md",
  loadRun: "docs/measurements/load-run.json",
  spans: "docs/measurements/load-run.spans.jsonl",
  priceTable: "packages/model-gateway/src/prices-openai.ts",
  threatModel: "docs/threat-model.md",
  limitations: "docs/limitations.md",
} as const;

/** The three components PRD 12 item 1 names, by the command that runs each. */
export const COMPONENT_COMMANDS = ["app:ingest", "app:api", "app:eval"] as const;

/** PRD 8.2's dimensions. Each must appear in an arm's metric table or be stated unavailable. */
export const METRIC_DIMENSIONS = [
  "Retrieval",
  "Fusion and rerank",
  "Citation",
  "Groundedness",
  "Abstention",
  "Governance",
  "Cost and latency",
] as const;

/** PRD 9.2's spans. "The full stage breakdown" in item 4 means every one of these. */
export const STAGES = [
  "query-normalisation",
  "permission-resolution",
  "permission-compile",
  "dense-retrieval",
  "lexical-retrieval",
  "fusion",
  "reranking",
  "prompt-assembly",
  "generation",
  "verification",
  "audit-write",
] as const;

/** PRD 12 item 6's four threats, as the threat model's section titles. */
export const THREATS = [
  "Tenant isolation",
  "Prompt injection through retrieved content",
  "Cache-key leakage",
  "Existence disclosure",
] as const;

/** PRD 12 item 7's four named limitations, and a pattern that recognises each in the list. */
export const REQUIRED_LIMITATIONS: readonly { readonly name: string; readonly pattern: RegExp }[] =
  [
    { name: "the synthetic corpus", pattern: /\bcorpus is synthetic\b/i },
    { name: "the English-only v1", pattern: /\*\*English[ -]only\b/i },
    { name: "the absence of real user traffic", pattern: /\bno real user traffic\b/i },
    { name: "judge-model bias in groundedness metrics", pattern: /\bjudge(?:'s|-model)? bias\b/i },
  ];

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const DATASET = /^[a-z0-9-]+@\d+\.\d+\.\d+ \(sha256:[0-9a-f]{64}\b/;

/** An identifier that names an in-repo stand-in rather than a model. */
export function isStandIn(model: unknown): boolean {
  return typeof model === "string" && model.startsWith("stand-in");
}

class Findings {
  readonly list: Finding[] = [];

  check(holds: boolean, text: string): boolean {
    this.list.push({ holds, text });
    return holds;
  }

  verdict(item: number, title: string, sources: readonly string[]): ItemVerdict {
    return {
      item,
      title,
      met: this.list.length > 0 && this.list.every((finding) => finding.holds),
      sources,
      findings: this.list,
    };
  }
}

function scriptsOf(view: RepositoryView): Record<string, unknown> {
  const manifest = parseJson(view.read(PATHS.packageJson));
  return isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
}

/** Every arm's run record, parsed, or `null` where it is missing or unreadable. */
export function runRecords(view: RepositoryView): Map<string, Record<string, unknown> | null> {
  const records = new Map<string, Record<string, unknown> | null>();
  for (const arm of ARMS) {
    const parsed = parseJson(view.read(PATHS.runJson(arm)));
    records.set(arm, isRecord(parsed) ? parsed : null);
  }
  return records;
}

export function loadRunRecord(view: RepositoryView): Record<string, unknown> | null {
  const parsed = parseJson(view.read(PATHS.loadRun));
  return isRecord(parsed) ? parsed : null;
}

function corpusSnapshotOf(view: RepositoryView): string | null {
  const inventory = parseJson(view.read(PATHS.inventory));
  const snapshot = isRecord(inventory) ? inventory.corpusSnapshot : undefined;
  return typeof snapshot === "string" && SHA256.test(snapshot) ? snapshot : null;
}

function metricRows(record: Record<string, unknown>): Record<string, unknown>[] {
  const metrics = record.metrics;
  return Array.isArray(metrics) ? metrics.filter(isRecord) : [];
}

function metricValue(record: Record<string, unknown>, metric: string): unknown {
  return metricRows(record).find((row) => row.metric === metric)?.value;
}

// ---------------------------------------------------------------------------------------------
// 1. A running system
// ---------------------------------------------------------------------------------------------

function runningSystem(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const scripts = scriptsOf(view);
  const readme = view.read(PATHS.appsReadme) ?? "";

  for (const command of COMPONENT_COMMANDS) {
    const script = scripts[command];
    const entry = typeof script === "string" ? /\btsx\s+(\S+\.ts)\b/.exec(script)?.[1] : undefined;
    findings.check(
      entry !== undefined && view.read(entry) !== null,
      entry === undefined
        ? `\`pnpm ${command}\` is not a script that runs a TypeScript entry point`
        : `\`pnpm ${command}\` runs \`${entry}\`, which ${view.read(entry) === null ? "does not exist" : "exists"}`,
    );
    findings.check(
      readme.includes(`pnpm ${command}`),
      `\`pnpm ${command}\` is ${readme.includes(`pnpm ${command}`) ? "" : "not "}documented in \`${PATHS.appsReadme}\``,
    );
  }

  const snapshot = corpusSnapshotOf(view);
  if (
    !findings.check(
      snapshot !== null,
      snapshot === null
        ? `\`${PATHS.inventory}\` records no corpus snapshot hash`
        : `the named corpus snapshot is \`${snapshot}\`, recorded in \`${PATHS.inventory}\``,
    )
  ) {
    return findings.verdict(1, "A running system", [
      PATHS.packageJson,
      PATHS.appsReadme,
      PATHS.inventory,
    ]);
  }

  for (const [arm, record] of runRecords(view)) {
    findings.check(
      record !== null &&
        record.corpusSnapshot === snapshot &&
        record.snapshotMatchesDatasets === true,
      record === null
        ? `the \`${arm}\` evaluation record is missing, so nothing shows the system ran against the snapshot`
        : record.corpusSnapshot !== snapshot
          ? `the \`${arm}\` evaluation ran against \`${String(record.corpusSnapshot)}\`, not the named snapshot`
          : record.snapshotMatchesDatasets === true
            ? `the \`${arm}\` evaluation ran against the named snapshot, and its datasets are labelled for it`
            : `the \`${arm}\` evaluation ran against the named snapshot, but its datasets are labelled for a different corpus`,
    );
  }

  const load = loadRunRecord(view);
  const profile = load !== null && isRecord(load.profile) ? load.profile : null;
  findings.check(
    profile?.corpusSnapshot === snapshot,
    profile === null
      ? "the load-run record is missing"
      : profile.corpusSnapshot === snapshot
        ? "the load run served the named snapshot"
        : `the load run served \`${String(profile.corpusSnapshot)}\`, not the named snapshot`,
  );

  return findings.verdict(1, "A running system", [
    PATHS.packageJson,
    PATHS.appsReadme,
    PATHS.inventory,
    ...ARMS.map(PATHS.runJson),
    PATHS.loadRun,
  ]);
}

// ---------------------------------------------------------------------------------------------
// 2. A published evaluation report
// ---------------------------------------------------------------------------------------------

/** The fields PRD 12 item 2 names that are single values, with how each is recognised. */
function recordFieldProblems(record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!(typeof record.commit === "string" && COMMIT.test(record.commit))) {
    problems.push("no commit SHA");
  }
  if (!(typeof record.corpusSnapshot === "string" && SHA256.test(record.corpusSnapshot))) {
    problems.push("no corpus snapshot hash");
  }
  const datasets = record.datasets;
  if (
    !Array.isArray(datasets) ||
    datasets.length === 0 ||
    !datasets.every((entry) => typeof entry === "string" && DATASET.test(entry))
  ) {
    problems.push("dataset versions and hashes missing or malformed");
  }
  const models = record.models;
  for (const role of ["embedder", "reranker", "generator", "judge"]) {
    if (!isRecord(models) || !nonEmptyString(models[role])) problems.push(`no ${role} identifier`);
  }
  const prompts = record.promptVersions;
  for (const role of ["answering", "judge"]) {
    if (!isRecord(prompts) || !nonEmptyString(prompts[role])) {
      problems.push(`no ${role} prompt version`);
    }
  }
  const runCount = record.runCount;
  if (!(typeof runCount === "number" && Number.isInteger(runCount) && runCount >= 1)) {
    problems.push("no run count");
  }
  const seeds = record.seeds;
  if (
    !isRecord(seeds) ||
    Object.keys(seeds).length === 0 ||
    !Object.values(seeds).every((seed) => typeof seed === "number" && Number.isFinite(seed))
  ) {
    problems.push("no seeds");
  }
  if (!nonEmptyString(record.measuredAt) || Number.isNaN(Date.parse(record.measuredAt))) {
    problems.push("no measurement time");
  }
  return problems;
}

function evaluationReport(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const records = runRecords(view);
  const sources: string[] = [];

  for (const [arm, record] of records) {
    sources.push(PATHS.runJson(arm), PATHS.runReport(arm));
    if (!findings.check(record !== null, `the \`${arm}\` arm has a run record`)) continue;
    if (record === null) continue;

    findings.check(
      record.arm === arm,
      `\`${PATHS.runJson(arm)}\` ${record.arm === arm ? "is" : "is not"} the record of the \`${arm}\` arm`,
    );
    findings.check(
      view.read(PATHS.runReport(arm)) !== null,
      `the \`${arm}\` arm has a rendered report`,
    );

    const problems = recordFieldProblems(record);
    findings.check(
      problems.length === 0,
      problems.length === 0
        ? `the \`${arm}\` record carries every field item 2 names: dataset versions and hashes, corpus snapshot hash, commit, the four model identifiers, prompt versions, run count, seeds`
        : `the \`${arm}\` record is incomplete: ${problems.join("; ")}`,
    );

    const models = isRecord(record.models) ? record.models : {};
    const standIns = ["embedder", "generator"].filter((role) => isStandIn(models[role]));
    findings.check(
      standIns.length === 0,
      standIns.length === 0
        ? `the \`${arm}\` arm's embedder and generator are models, not stand-ins`
        : `the \`${arm}\` arm's ${standIns.join(" and ")} ${standIns.length === 1 ? "is a stand-in" : "are stand-ins"}, so it measures the stand-in rather than the system`,
    );

    const perQueryFile = record.perQueryFile;
    const declared = record.perQueryRecords;
    const perQueryPath =
      typeof perQueryFile === "string" ? `${PATHS.evidenceDirectory}/${perQueryFile}` : null;
    const text = perQueryPath === null ? null : view.read(perQueryPath);
    const lines = text === null ? [] : jsonLines(text);
    const parseable = lines.every((line) => isRecord(parseJson(line)));
    if (perQueryPath !== null) sources.push(perQueryPath);
    findings.check(
      text !== null &&
        parseable &&
        typeof declared === "number" &&
        declared > 0 &&
        lines.length === declared,
      text === null
        ? `the \`${arm}\` arm's raw per-query file is missing`
        : !parseable
          ? `the \`${arm}\` arm's raw per-query file has a line that is not a JSON object`
          : `the \`${arm}\` arm's raw per-query file has ${String(lines.length)} record(s), and the report declares ${String(declared)}`,
    );

    const rows = metricRows(record);
    const unavailable = Array.isArray(record.unavailable)
      ? record.unavailable.filter(isRecord)
      : [];
    const malformed = rows.filter(
      (row) =>
        typeof row.value !== "number" ||
        !Number.isFinite(row.value) ||
        typeof row.sampleSize !== "number" ||
        row.sampleSize < 1,
    );
    const missing = METRIC_DIMENSIONS.filter(
      (dimension) =>
        !rows.some((row) => row.dimension === dimension) &&
        !unavailable.some((row) => row.dimension === dimension && nonEmptyString(row.reason)),
    );
    findings.check(
      rows.length > 0 && malformed.length === 0 && missing.length === 0,
      missing.length > 0
        ? `the \`${arm}\` metric table omits ${missing.join(", ")} without stating why`
        : malformed.length > 0
          ? `the \`${arm}\` metric table has ${String(malformed.length)} row(s) without a finite value and a sample size`
          : `the \`${arm}\` metric table covers every PRD 8.2 dimension: ${String(rows.length)} row(s), each with a sample size, and ${String(unavailable.length)} dimension(s) stated unavailable with a reason`,
    );
  }

  const present = [...records.values()].filter((record) => record !== null);
  if (present.length === ARMS.length) {
    const same = (field: string) =>
      new Set(present.map((record) => JSON.stringify(record[field]))).size === 1;
    const consistent = ["commit", "corpusSnapshot", "datasets", "splits"].filter(
      (field) => !same(field),
    );
    findings.check(
      consistent.length === 0,
      consistent.length === 0
        ? "all four arms ran at the same commit, over the same corpus snapshot, the same dataset versions and the same splits — so their deltas are comparable"
        : `the arms differ in ${consistent.join(", ")}, so the ablation compares different things`,
    );
  }

  const ablation = view.read(PATHS.ablation);
  sources.push(PATHS.ablation);
  const absent = ARMS.filter((arm) => !(ablation ?? "").includes(arm));
  findings.check(
    ablation !== null && absent.length === 0,
    ablation === null
      ? "the ablation report is missing"
      : absent.length === 0
        ? "the ablation report names every arm"
        : `the ablation report does not name ${absent.join(", ")}`,
  );

  return findings.verdict(2, "A published evaluation report", sources);
}

// ---------------------------------------------------------------------------------------------
// 3. A published governance report
// ---------------------------------------------------------------------------------------------

/** The governance report's fields, read by the patterns its generator writes. */
export interface GovernanceFields {
  readonly commit: string | null;
  readonly probeSet: string | null;
  readonly probesExecuted: number | null;
  readonly leakCount: number | null;
  readonly injectionProbes: number | null;
  readonly injectionLeaks: number | null;
  readonly auditFields: readonly string[];
}

function integerAfter(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text)?.[1];
  return match === undefined ? null : Number.parseInt(match, 10);
}

export function governanceFields(text: string): GovernanceFields {
  const audit = /^## Audit-record schema\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  return {
    commit: /^- \*\*Commit:\*\* ([0-9a-f]{7,40})$/m.exec(text)?.[1] ?? null,
    probeSet:
      /^- \*\*Dataset:\*\* (\S+@\d+\.\d+\.\d+) \(sha256:[0-9a-f]{64}/m.exec(text)?.[1] ?? null,
    probesExecuted: integerAfter(text, /^- \*\*Probes executed:\*\* (\d+)$/m),
    leakCount: integerAfter(text, /^## Leak count\n\n\*\*(\d+)\*\*/m),
    injectionProbes: integerAfter(text, /^- \*\*Injection probes:\*\* (\d+)$/m),
    injectionLeaks: integerAfter(text, /^- \*\*Leaks within the subset:\*\* (\d+)$/m),
    auditFields: [...audit.matchAll(/^- `([A-Za-z0-9_]+)`$/gm)].map((match) => match[1] ?? ""),
  };
}

function governanceReport(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const sources = [PATHS.governance, ...ARMS.map(PATHS.runJson)];
  const text = view.read(PATHS.governance);
  if (!findings.check(text !== null, "the governance report exists") || text === null) {
    return findings.verdict(3, "A published governance report", sources);
  }

  const fields = governanceFields(text);
  findings.check(
    fields.probeSet !== null,
    fields.probeSet === null
      ? "the governance report names no versioned, hashed probe set"
      : `the probe set is \`${fields.probeSet}\`, recorded with its hash`,
  );
  findings.check(
    fields.probesExecuted !== null && fields.probesExecuted > 0,
    `the report records ${fields.probesExecuted === null ? "no" : String(fields.probesExecuted)} probe(s) executed`,
  );
  // PRD 12 item 3: "a non-zero count blocks the promotion outright rather than being reported as
  // a caveat". It is one finding like the others, and like the others it makes the item unmet.
  findings.check(
    fields.leakCount === 0,
    fields.leakCount === null
      ? "the governance report records no leak count"
      : fields.leakCount === 0
        ? "the leak count is 0"
        : `the leak count is ${String(fields.leakCount)}, which blocks promotion outright (PRD 12 item 3)`,
  );
  findings.check(
    fields.injectionProbes !== null && fields.injectionProbes > 0 && fields.injectionLeaks !== null,
    fields.injectionProbes === null || fields.injectionProbes === 0
      ? "the report records no prompt-injection subset result"
      : `the prompt-injection subset result is recorded: ${String(fields.injectionLeaks)} leak(s) over ${String(fields.injectionProbes)} probe(s)`,
  );
  findings.check(
    fields.injectionLeaks === 0,
    `the prompt-injection subset leaked ${String(fields.injectionLeaks ?? "an unrecorded number of")} time(s)`,
  );
  findings.check(
    fields.auditFields.length > 0,
    fields.auditFields.length === 0
      ? "the report records no audit-record schema"
      : `the audit-record schema is recorded: ${String(fields.auditFields.length)} field(s), derived from a record the run wrote`,
  );

  const records = runRecords(view);
  const leaking = [...records]
    .filter(([, record]) => record === null || metricValue(record, "leak-count") !== 0)
    .map(([arm]) => arm);
  findings.check(
    leaking.length === 0,
    leaking.length === 0
      ? "every arm's own metric table also records a leak count of 0"
      : `the arm record(s) ${leaking.join(", ")} do not record a leak count of 0`,
  );

  const served = records.get(SERVED_ARM);
  const probeDataset =
    served !== null && served !== undefined && Array.isArray(served.datasets)
      ? served.datasets.find(
          (entry): entry is string =>
            typeof entry === "string" &&
            fields.probeSet !== null &&
            entry.startsWith(`${fields.probeSet} `),
        )
      : undefined;
  const servedCommit = served?.commit;
  findings.check(
    servedCommit !== undefined && fields.commit === servedCommit && probeDataset !== undefined,
    probeDataset === undefined
      ? "the governance report's probe set is not among the served arm's datasets"
      : fields.commit === servedCommit
        ? "the governance report comes from the same run as the served arm's evaluation"
        : "the governance report and the served arm's evaluation were produced at different commits",
  );

  return findings.verdict(3, "A published governance report", sources);
}

// ---------------------------------------------------------------------------------------------
// 4. A published cost and latency report
// ---------------------------------------------------------------------------------------------

function costAndLatencyReport(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const sources = [PATHS.loadRun, PATHS.spans, PATHS.costAndLatency, PATHS.priceTable];
  const record = loadRunRecord(view);
  if (
    !findings.check(record !== null, "the load-run record exists and parses") ||
    record === null
  ) {
    return findings.verdict(4, "A published cost and latency report", sources);
  }

  const profile = isRecord(record.profile) ? record.profile : {};
  const models = isRecord(profile.models) ? profile.models : {};
  const concurrency = profile.concurrency;
  const profileProblems = [
    nonEmptyString(profile.id) ? null : "no profile identifier",
    typeof profile.corpusSnapshot === "string" && SHA256.test(profile.corpusSnapshot)
      ? null
      : "no corpus snapshot",
    typeof profile.workload === "string" && SHA256.test(profile.workload)
      ? null
      : "no fixed workload hash",
    ["embedder", "generator", "reranker"].every((role) => nonEmptyString(models[role]))
      ? null
      : "model identifiers incomplete",
    nonEmptyString(profile.hardware) ? null : "no hardware description",
    typeof concurrency === "number" && Number.isInteger(concurrency) && concurrency >= 1
      ? null
      : "no concurrency level",
  ].filter((problem) => problem !== null);
  findings.check(
    profileProblems.length === 0,
    profileProblems.length === 0
      ? `the run records its reference profile \`${String(profile.id)}\`: corpus snapshot, fixed workload, model identifiers, hardware (${String(profile.hardware)}) and concurrency ${String(concurrency)}`
      : `the reference profile is incomplete: ${profileProblems.join("; ")}`,
  );

  const standIns = ["embedder", "generator"].filter((role) => isStandIn(models[role]));
  findings.check(
    standIns.length === 0,
    standIns.length === 0
      ? `the embedder and generator are models (\`${String(models.embedder)}\`, \`${String(models.generator)}\`), so the run measured the system rather than a stand-in`
      : `the ${standIns.join(" and ")} in the run ${standIns.length === 1 ? "is a stand-in" : "are stand-ins"}, so the figures omit the largest cost and latency a deployed system has`,
  );

  const version = record.priceTableVersion;
  const priceTable = view.read(PATHS.priceTable) ?? "";
  findings.check(
    nonEmptyString(version) && priceTable.includes(`"${version}"`),
    !nonEmptyString(version)
      ? "the run records no price table version"
      : priceTable.includes(`"${version}"`)
        ? `costs were computed from the versioned price table \`${version}\`, which is checked in`
        : `the run names price table \`${version}\`, which \`${PATHS.priceTable}\` does not declare`,
  );

  const latency = Array.isArray(record.latency) ? record.latency.filter(isRecord) : [];
  const measured = (stage: string) =>
    latency.some(
      (row) =>
        row.stage === stage &&
        typeof row.samples === "number" &&
        row.samples >= 1 &&
        typeof row.p95 === "number",
    );
  const missingStages = STAGES.filter((stage) => !measured(stage));
  findings.check(
    missingStages.length === 0 && measured("end-to-end"),
    missingStages.length > 0
      ? `the stage breakdown lacks ${missingStages.join(", ")}`
      : measured("end-to-end")
        ? `the stage breakdown has all ${String(STAGES.length)} PRD 9.2 stages and the end-to-end figure, each with its sample count`
        : "the breakdown has no end-to-end figure",
  );

  const requests = record.requests;
  const spans = view.read(PATHS.spans);
  const spanLines = spans === null ? [] : jsonLines(spans);
  const wellFormed = spanLines.every((line) => {
    const span = parseJson(line);
    return isRecord(span) && Array.isArray(span.stages);
  });
  findings.check(
    spans !== null && wellFormed && typeof requests === "number" && spanLines.length === requests,
    spans === null
      ? "the raw span export is missing"
      : !wellFormed
        ? "the raw span export has a line that is not a span with stages"
        : `the raw span export has ${String(spanLines.length)} request trace(s), and the record declares ${String(requests)} request(s)`,
  );

  const budgets = Array.isArray(record.budgets) ? record.budgets.filter(isRecord) : [];
  const unexplained = budgets.filter(
    (budget) => budget.value === null && !nonEmptyString(budget.unmeasured),
  );
  findings.check(
    budgets.length > 0 && unexplained.length === 0,
    budgets.length === 0
      ? "the record carries no budgets"
      : unexplained.length === 0
        ? `${String(budgets.filter((budget) => budget.value !== null).length)} of ${String(budgets.length)} PRD 9.3 budgets are measured, and each unmeasured one states why`
        : `${String(unexplained.length)} budget(s) are unmeasured without a stated reason`,
  );

  const report = view.read(PATHS.costAndLatency);
  const commit = record.commit;
  findings.check(
    report !== null && typeof commit === "string" && COMMIT.test(commit) && report.includes(commit),
    report === null
      ? "the rendered cost and latency report is missing"
      : typeof commit === "string" && report.includes(commit)
        ? `the rendered report is published and cites the run's commit \`${commit}\``
        : "the rendered report does not cite the run's commit",
  );

  return findings.verdict(4, "A published cost and latency report", sources);
}

// ---------------------------------------------------------------------------------------------
// 5. A boundary-enforcement artefact
// ---------------------------------------------------------------------------------------------

/** The module graph's edges, read from the artefact's fenced edge list. */
export function graphEdges(text: string): [string, string][] {
  const block = /^## Module graph\n[\s\S]*?```text\n([\s\S]*?)```/m.exec(text)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => /^(\S+) -> (\S+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => [match[1] ?? "", match[2] ?? ""]);
}

function boundaryArtefact(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const text = view.read(PATHS.boundaries);
  if (!findings.check(text !== null, "the boundary artefact exists") || text === null) {
    return findings.verdict(5, "A boundary-enforcement artefact", [PATHS.boundaries]);
  }

  findings.check(
    /`pnpm boundaries:check` passed over \d+ source file/.test(text),
    text.includes("`pnpm boundaries:check` passed")
      ? "it records `pnpm boundaries:check` passing"
      : "it does not record `pnpm boundaries:check` passing",
  );

  // Decided again from the edges rather than from the artefact's own sentence: the sentence is
  // the generator's opinion, and the edges are what it formed the opinion from.
  const edges = graphEdges(text);
  findings.check(
    edges.length > 0,
    `the generated dependency graph has ${String(edges.length)} edge(s)`,
  );
  const exhibits = [
    ...new Set(edges.map(([from]) => from).filter((from) => from.startsWith("exhibits/"))),
  ];
  const leaves = exhibits.filter((exhibit) => {
    const targets = edges.filter(([from]) => from === exhibit).map(([, to]) => to);
    return (
      targets.some((to) => to.startsWith("@atlasops/")) &&
      !targets.some((to) => to.startsWith("exhibits/") || to.startsWith("apps/"))
    );
  });
  findings.check(
    leaves.length >= 2,
    `${String(leaves.length)} exhibit(s) in the graph consume \`packages/*\` and import no other exhibit or application${leaves.length > 0 ? `: ${leaves.map((leaf) => `\`${leaf}\``).join(", ")}` : ""} — item 5 requires at least two`,
  );
  const stated = /^## PRD 12 item 5\n[\s\S]*?^\*\*(Met|Not met)\.\*\*/m.exec(text)?.[1];
  findings.check(
    stated === "Met",
    stated === undefined
      ? "the artefact states no verdict of its own"
      : `the artefact's own verdict is "${stated}", and agrees with the edges only if that is "Met"`,
  );

  return findings.verdict(5, "A boundary-enforcement artefact", [PATHS.boundaries]);
}

// ---------------------------------------------------------------------------------------------
// 6. A threat model
// ---------------------------------------------------------------------------------------------

export interface MitigationRow {
  readonly threat: string;
  readonly where: string | null;
  readonly testFile: string | null;
  readonly testName: string | null;
}

/** Every mitigation row in the threat model, by the section it sits in. */
export function mitigationRows(text: string): Map<string, MitigationRow[]> {
  const sections = new Map<string, MitigationRow[]>();
  const headings = [...text.matchAll(/^## \d+\. (.+)$/gm)];
  headings.forEach((heading, index) => {
    const threat = heading.at(1)?.trim() ?? "";
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const rows = text
      .slice(start, end)
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("|") && !/^\|\s*-/.test(line) && !/^\|\s*Mechanism\s*\|/.test(line),
      )
      .map((line) => {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        const where = /`([^`]+)`/.exec(cells[1] ?? "")?.[1] ?? null;
        const test = cells[2] ?? "";
        return {
          threat,
          where,
          testFile: /`([\w.-]+\.test\.ts)`/.exec(test)?.[1] ?? null,
          testName: /"([^"]+)"/.exec(test)?.[1] ?? null,
        };
      });
    sections.set(threat, rows);
  });
  return sections;
}

function threatModel(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const text = view.read(PATHS.threatModel);
  if (!findings.check(text !== null, "the threat model exists") || text === null) {
    return findings.verdict(6, "A threat model", [PATHS.threatModel]);
  }

  const sections = mitigationRows(text);
  const tests = view.testFiles();
  for (const threat of THREATS) {
    const rows = sections.get(threat);
    if (
      !findings.check(
        rows !== undefined && rows.length > 0,
        `"${threat}" has a section with mapped mitigations`,
      )
    ) {
      continue;
    }
    const problems: string[] = [];
    let named = 0;
    for (const row of rows ?? []) {
      if (row.where !== null && view.read(row.where) === null) {
        problems.push(`\`${row.where}\` does not exist`);
      }
      const candidates =
        row.testFile === null
          ? []
          : tests.filter((path) => path.endsWith(`/${row.testFile ?? ""}`));
      if (row.testFile === null) {
        problems.push("a mitigation names no test");
      } else if (candidates.length === 0) {
        problems.push(`\`${row.testFile}\` does not exist`);
      } else if (row.testName !== null) {
        const name = row.testName;
        if (candidates.some((path) => (view.read(path) ?? "").includes(name))) named += 1;
        else problems.push(`no \`${row.testFile}\` contains a test named "${name}"`);
      }
    }
    const count = rows?.length ?? 0;
    findings.check(
      problems.length === 0,
      problems.length === 0
        ? `"${threat}": ${String(count)} mitigation(s), each mapped to a test file that exists; ${String(named)} name the test case, which was found in that file, and ${String(count - named)} name the file and describe the case`
        : `"${threat}": ${problems.join("; ")}`,
    );
  }

  return findings.verdict(6, "A threat model", [PATHS.threatModel]);
}

// ---------------------------------------------------------------------------------------------
// 7. An honest limitations list
// ---------------------------------------------------------------------------------------------

function limitationsList(view: RepositoryView): ItemVerdict {
  const findings = new Findings();
  const text = view.read(PATHS.limitations);
  if (!findings.check(text !== null, "the limitations list exists") || text === null) {
    return findings.verdict(7, "An honest limitations list", [PATHS.limitations]);
  }
  for (const { name, pattern } of REQUIRED_LIMITATIONS) {
    findings.check(
      pattern.test(text),
      `it ${pattern.test(text) ? "states" : "does not state"} ${name}`,
    );
  }
  return findings.verdict(7, "An honest limitations list", [PATHS.limitations]);
}

/** Decides all seven items. Pure: the same files give the same verdict. */
export function decide(view: RepositoryView): Verdict {
  const items = [
    runningSystem(view),
    evaluationReport(view),
    governanceReport(view),
    costAndLatencyReport(view),
    boundaryArtefact(view),
    threatModel(view),
    limitationsList(view),
  ];
  return { items, allMet: items.every((item) => item.met) };
}
