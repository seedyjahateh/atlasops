import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  limitationEntries,
  propose,
  PROPOSAL_PATH,
  RefusedError,
  serialiseProposal,
  type Proposal,
} from "./proposal.js";
import { READINESS_PATH, renderReadiness } from "./render.js";
import { ARMS, decide, PATHS, SERVED_ARM, type Verdict } from "./verdict.js";
import {
  directoryView,
  isRecord,
  overlayView,
  parseJson,
  resolvePointer,
  type RepositoryView,
} from "./view.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");

/** The committed repository. The verdict is decided over the real artefacts, not a fixture. */
const repository = directoryView(ROOT);
const HISTORY = { started: "2026-09-20" };

function unmetItems(verdict: Verdict): number[] {
  return verdict.items.filter((item) => !item.met).map((item) => item.item);
}

function failing(verdict: Verdict, item: number): string[] {
  return (verdict.items[item - 1]?.findings ?? [])
    .filter((finding) => !finding.holds)
    .map((finding) => finding.text);
}

function withText(path: string, edit: (text: string) => string): RepositoryView {
  const text = repository.read(path);
  if (text === null) throw new Error(`fixture: ${path} is missing`);
  const edited = edit(text);
  if (edited === text) throw new Error(`fixture: the edit to ${path} changed nothing`);
  return overlayView(repository, { [path]: edited });
}

function withJson(path: string, edit: (document: Record<string, unknown>) => void): RepositoryView {
  return withText(path, (text) => {
    const document = parseJson(text);
    if (!isRecord(document)) throw new Error(`fixture: ${path} is not an object`);
    edit(document);
    return JSON.stringify(document, null, 2);
  });
}

function rows(document: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = document[key];
  if (!Array.isArray(value)) throw new Error(`fixture: ${key} is not an array`);
  return value.filter(isRecord);
}

describe("the verdict over the committed artefacts", () => {
  const verdict = decide(repository);

  it("finds all seven PRD 12 items met, with every finding holding", () => {
    expect(unmetItems(verdict)).toEqual([]);
    expect(verdict.allMet).toBe(true);
    for (const item of verdict.items) expect(failing(verdict, item.item)).toEqual([]);
  });

  it("decides each item from at least one finding, so no item is met vacuously", () => {
    expect(verdict.items.map((item) => item.item)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const item of verdict.items) expect(item.findings.length).toBeGreaterThan(0);
  });

  it("agrees with the committed readiness document and proposal", () => {
    // The same comparison `pnpm readiness:check` makes, so a stale document fails `pnpm test` too.
    const committed = repository.read(PROPOSAL_PATH);
    const started = (() => {
      const proposal = parseJson(committed);
      const changes = isRecord(proposal) ? proposal.changes : undefined;
      const dates = isRecord(changes) ? changes.dates : undefined;
      return isRecord(dates) && typeof dates.started === "string" ? dates.started : null;
    })();
    const proposal = propose(repository, verdict, { started });
    expect(repository.read(READINESS_PATH)).toBe(renderReadiness(verdict, proposal));
    expect(committed).toBe(serialiseProposal(proposal));
  });
});

describe("what the verdict may read", () => {
  it("imports nothing but Node built-ins and its own files", () => {
    // The verdict must be decidable from files a reviewer can open. A workspace import would let
    // it depend on code that computes rather than on artefacts that record — checked, not assumed.
    const sources = readdirSync(here).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = readFileSync(join(here, name), "utf8");
      const specifiers = [...text.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        expect(specifier, `${name} imports ${String(specifier)}`).toMatch(/^(?:node:|\.\/)/);
      }
    }
  });
});

describe("item 1: a running system", () => {
  it("is unmet when a component's command is not documented", () => {
    const view = withText(PATHS.appsReadme, (text) =>
      text.replaceAll("pnpm app:api", "pnpm start-the-api"),
    );
    expect(unmetItems(decide(view))).toEqual([1]);
    expect(failing(decide(view), 1).join()).toMatch(/app:api` is not documented/);
  });

  it("is unmet when a command's entry point does not exist", () => {
    const view = overlayView(repository, { "apps/ingest-worker/src/main.ts": null });
    expect(failing(decide(view), 1).join()).toMatch(/does not exist/);
  });

  it("is unmet when the evidence ran against a different corpus than the one named", () => {
    const view = withJson(PATHS.inventory, (inventory) => {
      inventory.corpusSnapshot = `sha256:${"0".repeat(64)}`;
    });
    expect(unmetItems(decide(view))).toContain(1);
    expect(failing(decide(view), 1).join()).toMatch(/not the named snapshot/);
  });

  it("is unmet when the datasets are labelled for a different corpus", () => {
    const view = withJson(PATHS.runJson("dense-only"), (record) => {
      record.snapshotMatchesDatasets = false;
    });
    expect(failing(decide(view), 1).join()).toMatch(/labelled for a different corpus/);
  });
});

describe("item 2: a published evaluation report", () => {
  it("is unmet, along with item 1, when an arm is missing", () => {
    const view = overlayView(repository, { [PATHS.runJson("lexical-only")]: null });
    expect(unmetItems(decide(view))).toEqual(expect.arrayContaining([1, 2]));
  });

  it("fails closed on an arm record that does not parse", () => {
    const view = overlayView(repository, { [PATHS.runJson("dense-only")]: "{ not json" });
    expect(unmetItems(decide(view))).toContain(2);
  });

  it("is unmet when a field item 2 names is absent", () => {
    for (const field of ["commit", "seeds", "promptVersions", "runCount", "datasets"]) {
      const view = withJson(PATHS.runJson(SERVED_ARM), (record) => {
        record[field] = undefined;
      });
      expect(unmetItems(decide(view)), field).toContain(2);
    }
  });

  it("is unmet when the judge identifier is missing", () => {
    const view = withJson(PATHS.runJson(SERVED_ARM), (record) => {
      const models = record.models;
      if (isRecord(models)) models.judge = "";
    });
    expect(failing(decide(view), 2).join()).toMatch(/no judge identifier/);
  });

  it("is unmet when the generator is a stand-in, because the report then measures the stand-in", () => {
    const view = withJson(PATHS.runJson(SERVED_ARM), (record) => {
      const models = record.models;
      if (isRecord(models)) models.generator = "stand-in-generator";
    });
    expect(failing(decide(view), 2).join()).toMatch(/generator is a stand-in/);
  });

  it("is unmet when the raw per-query file disagrees with the declared count", () => {
    const path = `${PATHS.evidenceDirectory}/run-${SERVED_ARM}.queries.jsonl`;
    const view = withText(path, (text) => text.split("\n").slice(1).join("\n"));
    expect(failing(decide(view), 2).join()).toMatch(/28 record\(s\), and the report declares 29/);
  });

  it("is unmet when a PRD 8.2 dimension is neither measured nor stated unavailable", () => {
    const view = withJson(PATHS.runJson("dense-only"), (record) => {
      record.metrics = rows(record, "metrics").filter((row) => row.dimension !== "Abstention");
    });
    expect(failing(decide(view), 2).join()).toMatch(/omits Abstention without stating why/);
  });

  it("is unmet when the arms ran at different commits, since their deltas then compare nothing", () => {
    const view = withJson(PATHS.runJson("dense-only"), (record) => {
      record.commit = "0000000";
    });
    expect(failing(decide(view), 2).join()).toMatch(/differ in commit/);
  });
});

describe("item 3: a published governance report", () => {
  it("is unmet, and blocks the proposal, when the leak count is not zero", () => {
    const view = withText(PATHS.governance, (text) =>
      text.replace("## Leak count\n\n**0**", "## Leak count\n\n**1**"),
    );
    const verdict = decide(view);
    expect(unmetItems(verdict)).toEqual([3]);
    expect(failing(verdict, 3).join()).toMatch(/blocks promotion outright/);
    expect(() => propose(view, verdict, HISTORY)).toThrow(RefusedError);
  });

  it("is unmet when an arm's own metric table records a leak the report does not", () => {
    const view = withJson(PATHS.runJson("fused-no-rerank"), (record) => {
      const leak = rows(record, "metrics").find((row) => row.metric === "leak-count");
      if (leak !== undefined) leak.value = 1;
    });
    expect(failing(decide(view), 3).join()).toMatch(
      /fused-no-rerank do not record a leak count of 0/,
    );
  });

  it("is unmet when the prompt-injection subset result is absent", () => {
    const view = withText(PATHS.governance, (text) =>
      text.replace(/^- \*\*Injection probes:\*\* \d+$/m, ""),
    );
    expect(failing(decide(view), 3).join()).toMatch(/no prompt-injection subset result/);
  });

  it("is unmet when the report comes from a different run than the evaluation", () => {
    const view = withText(PATHS.governance, (text) =>
      text.replace(/^- \*\*Commit:\*\* \S+$/m, "- **Commit:** 1234567"),
    );
    expect(failing(decide(view), 3).join()).toMatch(/different commits/);
  });
});

describe("item 4: a published cost and latency report", () => {
  it("is unmet when the raw span export is incomplete", () => {
    const view = withText(PATHS.spans, (text) => text.split("\n").slice(3).join("\n"));
    expect(unmetItems(decide(view))).toEqual([4]);
  });

  it("is unmet when the run used a stand-in generator", () => {
    const view = withJson(PATHS.loadRun, (record) => {
      const profile = record.profile;
      if (isRecord(profile) && isRecord(profile.models))
        profile.models.generator = "stand-in-generator";
    });
    expect(failing(decide(view), 4).join()).toMatch(/is a stand-in/);
  });

  it("is unmet when a PRD 9.2 stage is missing from the breakdown", () => {
    const view = withJson(PATHS.loadRun, (record) => {
      record.latency = rows(record, "latency").filter((row) => row.stage !== "verification");
    });
    expect(failing(decide(view), 4).join()).toMatch(/lacks verification/);
  });

  it("is unmet when the price table it names is not checked in", () => {
    const view = withJson(PATHS.loadRun, (record) => {
      record.priceTableVersion = "openai-1999-01-01";
    });
    expect(failing(decide(view), 4).join()).toMatch(/does not declare/);
  });

  it("is unmet when the profile omits the concurrency or the hardware", () => {
    const view = withJson(PATHS.loadRun, (record) => {
      const profile = record.profile;
      if (isRecord(profile)) profile.hardware = "";
    });
    expect(failing(decide(view), 4).join()).toMatch(/no hardware description/);
  });

  it("is unmet when a budget is unmeasured without a reason", () => {
    const view = withJson(PATHS.loadRun, (record) => {
      const ttft = rows(record, "budgets").find((budget) => budget.value === null);
      if (ttft !== undefined) ttft.unmeasured = null;
    });
    expect(failing(decide(view), 4).join()).toMatch(/unmeasured without a stated reason/);
  });
});

describe("item 5: a boundary-enforcement artefact", () => {
  it("decides from the edges, not from the artefact's own sentence", () => {
    // The artefact still says "Met"; the graph now shows one exhibit importing the other.
    const view = withText(PATHS.boundaries, (text) =>
      text.replace(
        "exhibits/rag-03-incident -> @atlasops/contracts",
        "exhibits/rag-03-incident -> @atlasops/contracts\nexhibits/rag-03-incident -> exhibits/rag-02-codebase",
      ),
    );
    expect(unmetItems(decide(view))).toEqual([5]);
    expect(failing(decide(view), 5).join()).toMatch(/1 exhibit\(s\)/);
  });

  it("is unmet when the artefact's own verdict is not met", () => {
    const view = withText(PATHS.boundaries, (text) =>
      text.replace(/^\*\*Met\.\*\*/m, "**Not met.**"),
    );
    expect(failing(decide(view), 5).join()).toMatch(/"Not met"/);
  });

  it("is unmet when the check did not pass", () => {
    const view = withText(PATHS.boundaries, (text) =>
      text.replace("`pnpm boundaries:check` passed", "`pnpm boundaries:check` failed"),
    );
    expect(failing(decide(view), 5).join()).toMatch(/does not record/);
  });
});

describe("item 6: a threat model", () => {
  it("is unmet when a named test case does not exist", () => {
    // The first run of this generator found exactly this in the committed threat model.
    const view = withText(PATHS.threatModel, (text) =>
      text.replace('"returns nothing the principal may not read"', '"a test nobody wrote"'),
    );
    expect(failing(decide(view), 6).join()).toMatch(/contains a test named "a test nobody wrote"/);
  });

  it("is unmet when a mitigation points at code that does not exist", () => {
    const view = withText(PATHS.threatModel, (text) =>
      text.replace("`packages/retrieval/src/cache.ts`", "`packages/retrieval/src/gone.ts`"),
    );
    expect(failing(decide(view), 6).join()).toMatch(/gone\.ts` does not exist/);
  });

  it("is unmet when one of PRD 12's four threats has no section", () => {
    const view = withText(PATHS.threatModel, (text) =>
      text.replace("## 3. Cache-key leakage", "## 3. Caching"),
    );
    expect(failing(decide(view), 6).join()).toMatch(/"Cache-key leakage" has a section/);
  });
});

describe("item 7: an honest limitations list", () => {
  it("is unmet when one of PRD 12's four limitations is missing", () => {
    const view = withText(PATHS.limitations, (text) =>
      text.replace("**English only.**", "**Languages.**"),
    );
    expect(unmetItems(decide(view))).toEqual([7]);
    expect(failing(decide(view), 7).join()).toMatch(/does not state the English-only v1/);
  });
});

describe("the proposal", () => {
  const verdict = decide(repository);
  const proposal: Proposal = propose(repository, verdict, HISTORY);
  const changes = proposal.changes;

  it("proposes measured, and leaves the review to a person", () => {
    expect(changes.proofLevel).toBe("measured");
    expect(changes.integrity).toEqual({ reviewedBy: null, reviewedAt: null });
    expect(proposal.target).toMatch(/portfolio repository/);
  });

  it("promotes no number its artefact does not contain", () => {
    expect(changes.metrics.length).toBeGreaterThan(0);
    for (const metric of changes.metrics) {
      const source = proposal.provenance.metrics[metric.id];
      expect(source, metric.id).toBeDefined();
      if (source === undefined) continue;
      const artefact = parseJson(repository.read(source.file));
      expect(resolvePointer(artefact, source.pointer), metric.id).toBe(metric.value);
      expect(metric.evidenceUrl.endsWith(source.file), metric.id).toBe(true);
    }
    const lastVerified = resolvePointer(
      parseJson(repository.read(proposal.provenance.lastVerified.file)),
      proposal.provenance.lastVerified.pointer,
    );
    expect(String(lastVerified).slice(0, 10)).toBe(changes.dates.lastVerified);
  });

  it("gives every metric the fields PRD 12 item 4 and the portfolio schema require", () => {
    // Categories and units from the portfolio's metrics.v1 vocabulary, by dimension (MET-UNIT-001).
    const unitDimension: Record<string, string> = {
      ms: "time",
      usd: "currency",
      "usd-per-1k": "currency",
      ratio: "ratio",
      count: "count",
    };
    const categoryDimensions: Record<string, readonly string[]> = {
      latency: ["time"],
      cost: ["currency", "ratio"],
      quality: ["ratio", "score"],
      reliability: ["ratio", "count", "time"],
    };
    const ids = changes.metrics.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const metric of changes.metrics) {
      expect(metric.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(metric.synthetic).toBe(true);
      expect(Number.isInteger(metric.sampleSize) && metric.sampleSize >= 1, metric.id).toBe(true);
      expect(metric.environment.length).toBeGreaterThanOrEqual(20);
      expect(metric.environment.length).toBeLessThanOrEqual(400);
      expect(metric.label.length).toBeLessThanOrEqual(120);
      expect(metric.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
      expect(metric.evidenceUrl).toMatch(/^https:\/\//);
      expect(categoryDimensions[metric.category], metric.id).toContain(unitDimension[metric.unit]);
    }
  });

  it("accounts for every served-arm metric and every budget: proposed or excluded with a reason", () => {
    const served = parseJson(repository.read(PATHS.runJson(SERVED_ARM)));
    const load = parseJson(repository.read(PATHS.loadRun));
    if (!isRecord(served) || !isRecord(load)) throw new Error("fixture: artefacts unreadable");
    const excludedText = proposal.excluded.map((entry) => entry.what).join("\n");
    const provenance = Object.values(proposal.provenance.metrics).map(
      (source) => `${source.file}#${source.pointer}`,
    );
    rows(served, "metrics").forEach((row, index) => {
      const proposed = provenance.includes(
        `${PATHS.runJson(SERVED_ARM)}#/metrics/${String(index)}/value`,
      );
      expect(proposed || excludedText.includes(`${String(row.metric)} (`), String(row.metric)).toBe(
        true,
      );
    });
    rows(load, "budgets").forEach((budget, index) => {
      const proposed = provenance.includes(`${PATHS.loadRun}#/budgets/${String(index)}/value`);
      expect(proposed || excludedText.includes(String(budget.id)), String(budget.id)).toBe(true);
    });
    for (const entry of proposal.excluded) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it("does not promote what a stand-in measured", () => {
    const excluded = new Map(
      proposal.excluded.map((entry) => [entry.what.split(" ")[0] ?? "", entry.reason]),
    );
    expect(excluded.get("supported-claim-rate")).toMatch(/stand-in judge/);
    expect(excluded.get("RERANK-STAGE-P95")).toMatch(/stand-in-reranker/);
    expect(excluded.get("TIME-TO-FIRST-TOKEN-P95")).toMatch(/^unmeasured/);
    expect(changes.metrics.map((metric) => metric.id)).not.toContain("rerank-stage-latency-p95");
  });

  it("would propose the rerank budget once a real reranker measured it", () => {
    const view = withJson(PATHS.loadRun, (record) => {
      const profile = record.profile;
      if (isRecord(profile) && isRecord(profile.models))
        profile.models.reranker = "a-selected-rerank-model";
    });
    const withReal = propose(view, decide(view), HISTORY);
    expect(withReal.changes.metrics.map((metric) => metric.id)).toContain(
      "rerank-stage-latency-p95",
    );
  });

  it("proposes the cache-miss latency beside the headline, which is mostly cache", () => {
    const ids = changes.metrics.map((metric) => metric.id);
    expect(ids).toEqual(
      expect.arrayContaining(["answer-latency-p95", "answer-latency-p95-cache-miss"]),
    );
    expect(changes.metrics.find((metric) => metric.id === "answer-latency-p95")?.label).toMatch(
      /retrieval-cache hits/,
    );
  });

  it("marks exactly one evidence item primary, with unique identifiers", () => {
    expect(changes.evidence.filter((entry) => entry.primary)).toHaveLength(1);
    const ids = changes.evidence.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(changes.evidence.map((entry) => entry.external as boolean)).not.toContain(true);
  });

  it("carries the content fields within the schema's bounds", () => {
    expect(changes.content.problem.length).toBeGreaterThanOrEqual(40);
    expect(changes.content.problem.length).toBeLessThanOrEqual(600);
    expect(changes.content.limitations.length).toBeGreaterThanOrEqual(4);
    for (const entry of changes.content.limitations) {
      expect(entry.length).toBeGreaterThanOrEqual(10);
      expect(entry.length).toBeLessThanOrEqual(400);
      expect(entry).not.toMatch(/\*\*|`/);
      expect(entry.endsWith(":")).toBe(false);
    }
  });

  it("says in-progress while the limitations record an unimplemented requirement, and complete once none does", () => {
    expect(changes.status).toBe("in-progress");
    const view = withText(PATHS.limitations, (text) =>
      text.replace("streaming is not implemented", "streaming is implemented"),
    );
    expect(propose(view, decide(view), HISTORY).changes.status).toBe("complete");
  });

  it("tells the reviewer when the served configuration is not the best-ranking arm", () => {
    expect(proposal.forTheReviewer.join("\n")).toMatch(
      /served configuration is not the best-ranking arm/,
    );
    for (const arm of ARMS.filter((candidate) => candidate !== SERVED_ARM)) {
      expect(proposal.forTheReviewer.join("\n")).toContain(arm);
    }
  });

  it("refuses rather than proposing when any item is unmet", () => {
    const view = withText(PATHS.limitations, (text) =>
      text.replace("**No real user traffic.**", "**Traffic.**"),
    );
    const refused = decide(view);
    expect(() => propose(view, refused, HISTORY)).toThrow(/item\(s\) 7 are not met/);
    const document = renderReadiness(refused, null);
    expect(document).toContain("## The refusal");
    expect(document).not.toContain("## The proposal");
    expect(document).toMatch(/6 of seven PRD 12 items are met/);
  });
});

describe("limitation entries", () => {
  it("takes bold-led paragraphs and the bullets that follow one, and skips the rest", () => {
    const text = [
      "## The four PRD 12 names",
      "",
      "**First limitation.** It has a reason.",
      "",
      "Plain prose that is not a limitation.",
      "",
      "- **A bullet after prose.** Not taken.",
      "",
      "## What this build actually has, beyond",
      "",
      "**Second limitation, with a list.** It introduces two parts:",
      "",
      "- **Part one.** Taken.",
      "- **Part two.** Also taken.",
      "",
      "---",
      "",
      "## Scope boundaries",
      "",
      "**A choice.** Not a limitation.",
    ].join("\n");
    expect(limitationEntries(text)).toEqual([
      "First limitation. It has a reason.",
      "Second limitation, with a list.",
      "Part one. Taken.",
      "Part two. Also taken.",
    ]);
  });
});
