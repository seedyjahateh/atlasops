/**
 * Evaluation runner tests.
 *
 * Two behaviours carry the phase's acceptance. The runner evaluates the same pipeline object the
 * API serves — asserted by there being exactly one `createAnswerPipeline` call and by the arms
 * running through `asAnswerSystem` — and it refuses to run a dataset against a corpus it was not
 * labelled for, which is PRD 8.1's second way to fake an improvement.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  artefactsFor,
  readRunnerConfig,
  runEvaluationSuite,
  runModels,
  runRecordOf,
  type DatasetsFile,
} from "./runner.js";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus", import.meta.url));
const DATASETS_PATH = fileURLToPath(
  new URL("../../../packages/evalkit/fixtures/datasets.v1.json", import.meta.url),
);

const DATASETS = JSON.parse(readFileSync(DATASETS_PATH, "utf8")) as DatasetsFile;

const ENV = {
  ATLASOPS_CORPUS_ROOT: CORPUS,
  ATLASOPS_DATASETS: DATASETS_PATH,
  ATLASOPS_ALLOW_SNAPSHOT_MISMATCH: "1",
} as const;

describe("configuration", () => {
  it("requires a corpus and a datasets file", () => {
    expect(() => readRunnerConfig({})).toThrow(/ATLASOPS_CORPUS_ROOT/);
    expect(() => readRunnerConfig({ ATLASOPS_CORPUS_ROOT: CORPUS })).toThrow(/ATLASOPS_DATASETS/);
  });

  it("defaults the evidence directory but not the inputs", () => {
    const config = readRunnerConfig(ENV);
    expect(config.outputDir).toBe("evidence");
    expect(config.allowSnapshotMismatch).toBe(true);
  });
});

describe("the artefacts carry every field PRD 12 item 2 names (P18b)", () => {
  // Until P18b, per-query results existed only inside the Markdown, and seeds, run count and the
  // answering prompt's version were recorded nowhere.

  it("writes a raw per-query file for every arm, one record per line", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    const files = artefactsFor(outcome);

    for (const run of outcome.runs) {
      const raw = files.find((file) => file.name === `run-${run.arm}.queries.jsonl`);
      expect(raw, run.arm).toBeDefined();
      const lines = (raw?.content ?? "").trim().split("\n");
      expect(lines).toHaveLength(run.perQuery.length);
      expect(JSON.parse(lines[0] ?? "{}")).toHaveProperty("itemId");
    }
  });

  it("records dataset hashes, snapshot, commit, models, prompt versions, run count and seeds", async () => {
    const outcome = await runEvaluationSuite(
      readRunnerConfig(ENV, ["--commit", "abc123"]),
      DATASETS,
    );
    const full = outcome.runs.find((run) => run.arm === "fused-with-rerank");
    expect(full).toBeDefined();
    if (full === undefined) return;

    const record = runRecordOf(full, outcome);
    expect(record.commit).toBe("abc123");
    expect(record.corpusSnapshot).toMatch(/^sha256:/);
    expect(record.datasets.every((ref) => ref.includes("sha256:"))).toBe(true);
    expect(Object.keys(record.models).sort()).toEqual([
      "embedder",
      "generator",
      "judge",
      "reranker",
    ]);
    expect(record.promptVersions.answering).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(record.promptVersions.judge).toBe("v1");
    expect(record.runCount).toBe(1);
    expect(record.seeds.bootstrap).toBeGreaterThan(0);
    expect(record.perQueryFile).toBe("run-fused-with-rerank.queries.jsonl");
    expect(record.metrics.length).toBeGreaterThan(0);
  });
});

describe("which models answer (P18a)", () => {
  it("defaults to the stand-ins", () => {
    // A command that spends money must not do so because somebody forgot a flag.
    expect(readRunnerConfig(ENV).models).toBe("stand-in");
  });

  it("takes the OpenAI set only when asked", () => {
    expect(readRunnerConfig(ENV, ["--models", "openai"]).models).toBe("openai");
  });

  it("refuses a model set it does not have", () => {
    expect(() => readRunnerConfig(ENV, ["--models", "gpt-9"])).toThrow(/ATLASOPS_MODELS/);
  });

  it("refuses to run the OpenAI set without a key, before ingesting anything", async () => {
    // The key is checked first, so a missing one costs nothing and names the variable.
    await expect(
      runEvaluationSuite(readRunnerConfig(ENV, ["--models", "openai"]), DATASETS, {}),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });

  it("records the stand-ins by name when they answered", () => {
    const models = runModels("stand-in", {});
    expect(Object.values(models.identifiers).every((id) => id.startsWith("stand-in"))).toBe(true);
  });
});

describe("running the suite", () => {
  it("refuses a dataset labelled against a different corpus", async () => {
    // PRD 8.1: re-ingesting the corpus is one of the two most effective ways to fake an
    // improvement, so the default is to refuse rather than to warn.
    const strict = readRunnerConfig({
      ATLASOPS_CORPUS_ROOT: CORPUS,
      ATLASOPS_DATASETS: DATASETS_PATH,
    });

    await expect(runEvaluationSuite(strict, DATASETS)).rejects.toThrow(
      /labelled against a different corpus/,
    );
  });

  it("refuses a datasets file that declares nothing", async () => {
    await expect(runEvaluationSuite(readRunnerConfig(ENV), {})).rejects.toThrow(
      /reads like a clean result/,
    );
  });

  it("runs every arm over one ingestion", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);

    expect(outcome.runs.map((run) => run.arm)).toEqual([
      "dense-only",
      "lexical-only",
      "fused-no-rerank",
      "fused-with-rerank",
    ]);
    // Every arm saw the same corpus: an ablation across four ingestions is a comparison of four
    // corpora.
    expect(new Set(outcome.runs.map((run) => run.datasets.join("|"))).size).toBe(1);
    expect(outcome.corpusSnapshot).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records that the snapshot did not match, rather than quietly proceeding", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    expect(outcome.snapshotMatchesDatasets).toBe(false);

    const ablation = artefactsFor(outcome).find((artefact) => artefact.name === "ablation.md");
    expect(ablation?.content).toContain("not labelled against this corpus");
  });

  it("writes a report, a raw per-query file and a record per arm, then governance and ablation", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    const names = artefactsFor(outcome).map((artefact) => artefact.name);

    const perArm = (arm: string) => [
      `run-${arm}.md`,
      `run-${arm}.queries.jsonl`,
      `run-${arm}.json`,
    ];
    expect(names).toEqual([
      ...perArm("dense-only"),
      ...perArm("lexical-only"),
      ...perArm("fused-no-rerank"),
      ...perArm("fused-with-rerank"),
      "governance.md",
      "ablation.md",
    ]);
  });

  it("renders the governance report from the full arm, not an ablated one", async () => {
    // A leak count from an ablated arm says nothing about the configuration a deployment serves.
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    const governance = artefactsFor(outcome).find((a) => a.name === "governance.md");

    expect(governance?.content).toContain("**Arm:** fused-with-rerank");
    expect(governance?.content).toContain("permission-probe@1.2.0");
    // The injection probe is in the development split, so the routine run exercises it. It was
    // held out until P14b, which meant the gate that runs on every build never saw an injection.
    expect(governance?.content).toContain("**Injection probes:** 1");
  });

  it("derives the audit schema from a record the run actually wrote", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    expect(outcome.auditSample).not.toBeNull();

    const governance = artefactsFor(outcome).find((a) => a.name === "governance.md");
    expect(governance?.content).toContain("`groupSetHash`");
  });

  it("records the model identifiers PRD 12 item 2 requires", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    for (const run of outcome.runs) {
      expect(run.models).toEqual({
        embedder: "stand-in-embedder",
        reranker: "stand-in-reranker",
        generator: "stand-in-not-a-model",
        judge: "stand-in-judge",
      });
    }
  });

  it("records the commit when one is supplied, and its absence when not", async () => {
    const withCommit = readRunnerConfig({ ...ENV, ATLASOPS_COMMIT: "abc123" });
    expect((await runEvaluationSuite(withCommit, DATASETS)).commit).toBe("abc123");
    expect((await runEvaluationSuite(readRunnerConfig(ENV), DATASETS)).commit).toBeNull();
  });

  it("says in the ablation artefact that a negative delta is not a build failure", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    const ablation = artefactsFor(outcome).find((artefact) => artefact.name === "ablation.md");

    expect(ablation?.content).toContain("An ablation is not a regression");
  });

  it("carries the judge's pinned identity into every run report", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    for (const run of outcome.runs) {
      expect(run.judge).toEqual({ modelId: "stand-in-judge", promptVersion: "v1" });
    }
  });
});
