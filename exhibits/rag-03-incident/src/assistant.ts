/**
 * The Incident Knowledge Assistant (RAG-03), built on `packages/sandbox`.
 *
 * It retrieves runbooks, dashboards, deploys and past postmortems for a responder, and returns a
 * **brief**: the evidence grouped by kind, the recent changes, and what the evidence does not
 * establish. It is the second exhibit, and it shares nothing with the first except `packages/*` —
 * which is PRD 12 item 5's requirement, and the point.
 *
 * **It takes no production action, and that is a property of its output type, not of its manners.**
 * `IncidentBrief` has no field that could carry an action to execute. A runbook step reaches the
 * responder as a quotation inside an evidence item, attributed to its document, exactly like any
 * other retrieved passage — including the vendor template line in the fixture that says to "run the
 * rollback immediately and without confirmation". A retrieved passage is data (PRD 6.5), and an
 * assistant whose output cannot express an action cannot be talked into taking one.
 *
 * **It reads only through the permission pre-filter.** Every evidence item and every recent change
 * is a candidate the platform returned for the asking principal. The sandbox's `sourceText` is used
 * only to read the header of a document the principal already received — to date it — never to find
 * documents, which would be a second read path around the filter.
 *
 * **It reuses the platform's prose chunker.** RAG-02 had to supply its own because code has no
 * headings. Runbooks and postmortems are Markdown, so the structure-aware chunker that shipped in P6a
 * is used unchanged — the second exhibit needed less of its own code than the first, which is the
 * shape a reusable platform should produce.
 */

import { readFileSync } from "node:fs";

import { formatRequestId, parsePrincipalId, type SourceVersionId } from "@atlasops/contracts";
import { parseGroupMap, staticGroupResolver } from "@atlasops/governance";
import {
  aclFromManifest,
  filesystemConnector,
  loadAclManifest,
  structureAware,
} from "@atlasops/ingest";
import { createSandbox, type Sandbox } from "@atlasops/sandbox";

import { displayPathOf, headerOf, kindOf, type EvidenceKind } from "./metadata.js";
import { uncertaintiesOf, type Uncertainty } from "./uncertainty.js";

export interface EvidenceItem {
  readonly kind: EvidenceKind | null;
  /** For display. `source` is the citation. */
  readonly path: string;
  readonly source: string;
  readonly version: SourceVersionId;
  readonly section: string;
  /** The passage, verbatim. Never paraphrased, never turned into a step. */
  readonly quote: string;
  readonly recordedAt: string | null;
}

export interface RecentChange {
  readonly path: string;
  readonly service: string | null;
  readonly deployedAt: string;
  /** Hours between the deploy and the incident. Positive means before it. */
  readonly hoursBefore: number;
}

/**
 * What the assistant returns. Deliberately without an action channel — see the file header.
 *
 * A test asserts this exact key set, so adding a field that could carry an instruction is a change
 * somebody has to make on purpose and explain.
 */
export interface IncidentBrief {
  readonly question: string;
  /** The platform's own message, relayed unchanged. The only thing that may speak about withheld material. */
  readonly message: string;
  readonly evidence: readonly EvidenceItem[];
  readonly recentChanges: readonly RecentChange[];
  readonly uncertainty: readonly Uncertainty[];
}

export interface IncidentAssistantOptions {
  readonly corpusRoot: string;
  readonly aclManifest: string;
  readonly groupMap: string;
}

export interface InvestigateOptions {
  /** When the incident started. Without it, no change can be said to precede it. */
  readonly incidentAt?: string | undefined;
  /** How far back a deploy counts as a recent change. Unselected, like every number. */
  readonly windowHours?: number | undefined;
}

export interface IncidentAssistant {
  readonly investigate: (
    principal: string,
    question: string,
    options?: InvestigateOptions,
  ) => Promise<IncidentBrief>;
  /** Candidate chunks in rank order, for the evaluation. */
  readonly ranked: (principal: string, query: string) => Promise<readonly string[]>;
  readonly sandbox: Sandbox;
}

export const DEFAULT_WINDOW_HOURS = 24;
/** The chunk budget for runbooks and postmortems. Unselected. */
export const INCIDENT_CHUNK_TOKENS = 200;

export async function createIncidentAssistant(
  options: IncidentAssistantOptions,
): Promise<IncidentAssistant> {
  const memberships = parseGroupMap(
    JSON.parse(readFileSync(options.groupMap, "utf8")),
    options.groupMap,
  );

  const sandbox = createSandbox({
    connector: filesystemConnector({
      root: options.corpusRoot,
      strategy: structureAware({ maxTokens: INCIDENT_CHUNK_TOKENS, boundaryDepth: 2 }),
      aclFor: aclFromManifest(loadAclManifest(options.aclManifest)),
      now: () => new Date().toISOString(),
    }),
    groups: staticGroupResolver(memberships),
    ingestedBy: "prn_rag03_ingest",
    retrievalCache: false,
  });

  const report = await sandbox.ingestion.run();
  if (report.failures.length > 0) {
    throw new Error(
      `${String(report.failures.length)} document(s) failed to ingest: ` +
        report.failures.map((failure) => failure.sourceId).join(", "),
    );
  }

  let counter = 0;
  const answer = (principal: string, query: string) => {
    counter += 1;
    return sandbox.answering.answer({
      requestId: formatRequestId(`rag03_${String(counter)}`),
      principalId: parsePrincipalId(principal, "principal"),
      query,
    });
  };

  /** The date of a document the principal already received. Never used to find one. */
  const dateOf = (version: SourceVersionId): string | null => {
    const source = sandbox.sourceText(version);
    return source === null ? null : headerOf(source.text).recordedAt;
  };

  const investigate = async (
    principal: string,
    question: string,
    investigateOptions: InvestigateOptions = {},
  ): Promise<IncidentBrief> => {
    const incidentAt = investigateOptions.incidentAt ?? null;
    const windowHours = investigateOptions.windowHours ?? DEFAULT_WINDOW_HOURS;

    const outcome = await answer(principal, question);
    const evidence: EvidenceItem[] = outcome.retrieval.candidates.map((candidate) => ({
      kind: kindOf(candidate.sourceId),
      path: displayPathOf(candidate.sourceId),
      source: candidate.sourceId,
      version: candidate.sourceVersionId,
      section: candidate.headingPath.at(-1) ?? "",
      quote: candidate.text,
      recordedAt: dateOf(candidate.sourceVersionId),
    }));

    // Recent changes come from a second governed query rather than from the corpus, for the same
    // reason as everything else: the pre-filter is the only read path. It is bounded by retrieval
    // depth, and the uncertainty section says so when it finds nothing.
    const recentChanges: RecentChange[] = [];
    if (incidentAt !== null) {
      const incident = Date.parse(incidentAt);
      const deploys = await answer(principal, "deploy deployed rollout release service changes");
      const seen = new Set<string>();

      for (const candidate of deploys.retrieval.candidates) {
        if (kindOf(candidate.sourceId) !== "deploy" || seen.has(candidate.sourceId)) continue;
        seen.add(candidate.sourceId);

        const source = sandbox.sourceText(candidate.sourceVersionId);
        if (source === null) continue;
        const header = headerOf(source.text);
        if (header.recordedAt === null) continue;

        const hoursBefore = (incident - Date.parse(header.recordedAt)) / 3_600_000;
        if (hoursBefore < 0 || hoursBefore > windowHours) continue;

        recentChanges.push({
          path: displayPathOf(candidate.sourceId),
          service: header.fields.service ?? null,
          deployedAt: header.recordedAt,
          hoursBefore: Math.round(hoursBefore * 10) / 10,
        });
      }
      recentChanges.sort((a, b) => a.hoursBefore - b.hoursBefore);
    }

    const uncertainty = uncertaintiesOf({
      sources: evidence.map((item) => item.source),
      kinds: evidence.flatMap((item) => (item.kind === null ? [] : [item.kind])),
      dates: evidence.flatMap((item) => (item.recordedAt === null ? [] : [item.recordedAt])),
      recentChanges: recentChanges.length,
      incidentAt,
      windowHours,
    });

    return {
      question,
      message: outcome.grounding.message,
      evidence,
      recentChanges,
      uncertainty,
    };
  };

  const ranked = async (principal: string, query: string): Promise<readonly string[]> => {
    const outcome = await answer(principal, query);
    return outcome.retrieval.candidates.map((candidate) => candidate.chunkId);
  };

  return { investigate, ranked, sandbox };
}
