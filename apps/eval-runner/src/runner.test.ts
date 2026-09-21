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

import { artefactsFor, readRunnerConfig, runEvaluationSuite, type DatasetsFile } from "./runner.js";

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

  it("writes one artefact per arm plus the ablation deltas", async () => {
    const outcome = await runEvaluationSuite(readRunnerConfig(ENV), DATASETS);
    const names = artefactsFor(outcome).map((artefact) => artefact.name);

    expect(names).toEqual([
      "run-dense-only.md",
      "run-lexical-only.md",
      "run-fused-no-rerank.md",
      "run-fused-with-rerank.md",
      "ablation.md",
    ]);
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
