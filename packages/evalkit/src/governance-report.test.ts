/**
 * Governance report tests (P12 item 3).
 *
 * This is the one required artefact the build produces without qualification, which makes its
 * failure modes worth testing rather than reading. The two that matter: a set with no injection
 * probe must say so rather than letting a zero leak count imply an injection result, and the audit
 * schema must come from a record the run wrote rather than from a list somebody maintained.
 */

import { formatPrincipalId, formatRequestId, contentHashOf } from "@atlasops/contracts";
import { createAuthorizationJournal, type AuditRecord } from "@atlasops/governance";
import { describe, expect, it } from "vitest";

import { loadDataset, type Dataset, type DatasetInput } from "./dataset.js";
import {
  INJECTION_SUBPOPULATION,
  probeOutcomesOf,
  renderGovernanceReport,
} from "./governance-report.js";
import type { QueryRecord, RunReport } from "./harness.js";
import type { PermissionProbeItem } from "./shapes.js";

const FORBIDDEN = "chk_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd_0";
const ALLOWED = "chk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_0";

function probeSet(items: readonly PermissionProbeItem[]): Dataset<PermissionProbeItem> {
  const input: DatasetInput<PermissionProbeItem> = {
    id: "permission-probe",
    version: "9.9.9",
    kind: "permission-probe",
    corpusSnapshot: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    items,
  };
  return loadDataset(input);
}

function probe(id: string, overrides: Partial<PermissionProbeItem> = {}): PermissionProbeItem {
  return {
    id,
    split: "development",
    query: "what is in the quarterly ledger",
    principal: "prn_alice",
    forbiddenChunks: [FORBIDDEN],
    existenceDisclosable: false,
    ...overrides,
  };
}

function record(itemId: string, materialised: readonly string[]): QueryRecord {
  return {
    itemId,
    arm: "fused-with-rerank",
    query: "q",
    principal: "prn_alice",
    abstained: materialised.length === 0,
    candidateChunks: materialised,
    citedChunks: [],
    message: "No relevant material was found for this query.",
    latencyMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    degraded: [],
  };
}

function run(records: readonly QueryRecord[]): RunReport {
  return {
    runId: "run",
    system: "test",
    arm: "fused-with-rerank",
    models: { embedder: "stand-in-embedder" },
    commit: "abc123",
    datasets: [],
    splits: ["development"],
    table: [],
    latency: [],
    costPerAnswer: null,
    perQuery: records,
    governance: null,
    judge: null,
    measuredAt: "2026-05-01T00:00:00.000Z",
  };
}

function auditSample(): AuditRecord {
  const journal = createAuthorizationJournal({
    requestId: formatRequestId("r1"),
    principal: { id: formatPrincipalId("alice"), groups: [] },
    queryHash: contentHashOf("q"),
  });
  return journal.seal({
    promptChunks: [],
    citedChunks: [],
    models: ["stand-in-not-a-model"],
    inputTokens: 1,
    outputTokens: 1,
    costUsd: null,
    stageTimings: [],
    writtenAt: "2026-05-01T00:00:00.000Z",
  });
}

describe("probe outcomes come from the records the run already retained", () => {
  it("takes only the probe set's items", () => {
    const probes = probeSet([probe("prb-001")]);
    const outcomes = probeOutcomesOf(
      run([record("prb-001", [ALLOWED]), record("rel-001", [FORBIDDEN])]),
      probes,
    );

    expect(outcomes.map((outcome) => outcome.itemId)).toEqual(["prb-001"]);
    expect(outcomes[0]?.materialised).toEqual([ALLOWED]);
  });
});

describe("the report", () => {
  const clean = run([record("prb-001", [ALLOWED]), record("prb-002", [ALLOWED])]);

  it("records the probe set version and the number of probes", () => {
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([probe("prb-001"), probe("prb-002")]),
      auditSample: auditSample(),
      commit: "abc123",
    });

    expect(rendered).toContain("permission-probe@9.9.9");
    expect(rendered).toContain("**Probes declared:** 2");
    // Declared and in-scope are separate numbers on purpose: a run that read development only has
    // said nothing about the held-out probes, and must not be read as having cleared them.
    expect(rendered).toContain("**Probes in scope for this run:** 2");
    expect(rendered).toContain("**Commit:** abc123");
  });

  it("scores only the probes the run was in scope for", () => {
    // The failure this prevents: a held-out probe that never ran being counted as clean, which
    // would make the leak gate pass over material it never looked at.
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([
        probe("prb-001"),
        probe("prb-002"),
        probe("prb-003", { split: "held-out" }),
      ]),
      auditSample: auditSample(),
      commit: null,
    });

    expect(rendered).toContain("**Probes declared:** 3");
    expect(rendered).toContain("**Probes in scope for this run:** 2");
    expect(rendered).toContain("**0**, summed over 2 probes");
  });

  it("reports a clean leak count and says why a leak would not have reached this file", () => {
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([probe("prb-001"), probe("prb-002")]),
      auditSample: auditSample(),
      commit: null,
    });

    expect(rendered).toContain("**0**, summed over 2 probes");
    expect(rendered).toContain("build failure rather than a caveat");
  });

  it("reports the injection subset separately", () => {
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([
        probe("prb-001"),
        probe("prb-002", { subpopulation: INJECTION_SUBPOPULATION }),
      ]),
      auditSample: auditSample(),
      commit: null,
    });

    expect(rendered).toContain("**Injection probes:** 1");
    expect(rendered).toContain("**Leaks within the subset:** 0");
  });

  it("says the injection row is unevidenced when no probe is marked", () => {
    // A leak count of zero over a set containing no injection probe says nothing about injection,
    // and a report that omitted the row would let it read as though it did.
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([probe("prb-001"), probe("prb-002")]),
      auditSample: auditSample(),
      commit: null,
    });

    expect(rendered).toContain("No probe in this set is marked as an injection probe");
    expect(rendered).toContain("leaves this");
  });

  it("derives the audit schema from a record rather than transcribing it", () => {
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([probe("prb-001"), probe("prb-002")]),
      auditSample: auditSample(),
      commit: null,
    });

    for (const field of ["principalId", "groupSetHash", "predicate", "citedChunks", "costUsd"]) {
      expect(rendered).toContain(`\`${field}\``);
    }
  });

  it("says so when no audit record was produced", () => {
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([probe("prb-001"), probe("prb-002")]),
      auditSample: null,
      commit: null,
    });
    expect(rendered).toContain("No audit record was produced");
  });

  it("states what the artefact does not support", () => {
    // The distinction the whole build turns on: this number is about the pre-filter, which ships;
    // every other number is about a stand-in.
    const rendered = renderGovernanceReport({
      run: clean,
      probes: probeSet([probe("prb-001")]),
      auditSample: auditSample(),
      commit: null,
    });

    expect(rendered).toContain("supports no claim about retrieval quality");
    expect(rendered).toContain("promotion-readiness.md");
  });

  it("refuses to render for a probe that did not run", () => {
    // A probe that did not execute cannot be counted as clean, and the metric says so rather than
    // the report quietly covering two probes when three were declared.
    expect(() =>
      renderGovernanceReport({
        run: run([record("prb-001", [ALLOWED])]),
        probes: probeSet([probe("prb-001"), probe("prb-002")]),
        auditSample: auditSample(),
        commit: null,
      }),
    ).toThrow(/did not run/);
  });

  it("reports a leak loudly when one happened", () => {
    const leaked = run([record("prb-001", [FORBIDDEN])]);
    const rendered = renderGovernanceReport({
      run: leaked,
      probes: probeSet([probe("prb-001")]),
      auditSample: auditSample(),
      commit: null,
    });

    expect(rendered).toContain("**1 leak(s). This blocks promotion outright");
  });
});
