/**
 * The Codebase Intelligence Assistant (RAG-02), assembled from the platform's packages.
 *
 * Everything that is not about code comes from `packages/*` unchanged: the corpus store, ingestion,
 * the permission pre-filter, hybrid retrieval, grounding, verification and the audit. What this
 * exhibit adds is three things only a codebase needs — a chunker that knows where a declaration
 * starts, citations as line ranges, and a call graph — and none of them required a package to
 * change. That is the claim PRD 11.2's layering makes, and this is the first code to test it.
 *
 * **Repository boundaries are the platform's access zones.** Each repository is a prefix in the
 * access manifest, so a principal who may not read `payments/` never has a payments chunk reach
 * their candidate set: the pre-filter, not this file, is what enforces it. The call graph is the
 * one index this exhibit owns, and it respects the same boundary by never recording an edge across
 * it (see `callgraph.ts`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  contentHashOf,
  formatRequestId,
  formatSourceVersionId,
  parsePrincipalId,
  type Answer,
  type SourceVersionId,
} from "@atlasops/contracts";
import { parseGroupMap, staticGroupResolver } from "@atlasops/governance";
import {
  aclFromManifest,
  filesystemConnector,
  loadAclManifest,
  type StoredChunk,
} from "@atlasops/ingest";
import { createSandbox } from "@atlasops/sandbox";

import { buildCallGraph, type CallGraph, type SourceFile, type SymbolRef } from "./callgraph.js";
import { linesInVersion, renderLines, type LineRange } from "./lines.js";
import { symbolAware } from "./strategy.js";

/** A chunk budget sized for a function rather than a page. Unselected, like every other. */
export const CODE_CHUNK_TOKENS = 200;

export interface AssistantOptions {
  readonly repositoryRoot: string;
  readonly aclManifest: string;
  readonly groupMap: string;
}

export interface Citation {
  readonly path: string;
  readonly version: SourceVersionId;
  readonly lines: LineRange;
  /** `payments/refunds.ts:31-43` */
  readonly rendered: string;
  /**
   * `span` when the cited characters were resolved exactly; `chunk` when the model's span could not
   * be mapped back to the source and the whole chunk's lines are given instead. Saying which is the
   * difference between a precise citation and a wide one that looks precise.
   */
  readonly precision: "span" | "chunk";
  /** The symbol names the cited chunk belongs to. */
  readonly symbols: readonly string[];
}

export interface AssistantAnswer {
  readonly answer: Answer;
  readonly message: string;
  readonly citations: readonly Citation[];
  /** Callers and callees of the cited symbols. Same repository only — see `callgraph.ts`. */
  readonly related: readonly {
    readonly of: string;
    readonly callers: readonly SymbolRef[];
    readonly callees: readonly SymbolRef[];
  }[];
}

export interface Assistant {
  readonly ask: (principal: string, query: string) => Promise<AssistantAnswer>;
  /** The candidate chunks, in rank order, for the same query. What recall and MRR are scored on. */
  readonly ranked: (principal: string, query: string) => Promise<readonly string[]>;
  readonly graph: CallGraph;
  /** Every chunk the ingestion wrote. For label resolution in the evaluation, not for answering. */
  readonly chunks: () => Promise<readonly StoredChunk[]>;
  readonly files: readonly SourceFile[];
  readonly versionOf: (path: string) => SourceVersionId | null;
}

/** The TypeScript files under a root, read once, keyed by the version their bytes produce. */
export function readRepositories(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push({
          path: relative(root, path).split(sep).join("/"),
          text: readFileSync(path, "utf8"),
        });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function symbolNamesOf(chunk: StoredChunk): readonly string[] {
  // Heading paths are `${kind} ${name}`, one per name the declaration introduces.
  return chunk.chunk.headingPath.map((heading) => heading.slice(heading.indexOf(" ") + 1));
}

export async function createAssistant(options: AssistantOptions): Promise<Assistant> {
  const memberships = parseGroupMap(
    JSON.parse(readFileSync(options.groupMap, "utf8")),
    options.groupMap,
  );

  // The platform, constructed by `packages/sandbox` rather than by hand. This exhibit built the
  // same fifty lines itself in P16; the second exhibit needing them too is what promoted them
  // (ADR 0008). What remains here is only what is RAG-02's: the code chunker and the connector.
  const sandbox = createSandbox({
    connector: filesystemConnector({
      root: options.repositoryRoot,
      strategy: symbolAware({ maxTokens: CODE_CHUNK_TOKENS }),
      aclFor: aclFromManifest(loadAclManifest(options.aclManifest)),
      extensions: [".ts"],
      now: () => new Date().toISOString(),
    }),
    groups: staticGroupResolver(memberships),
    ingestedBy: "prn_rag02_ingest",
    // Off: every question is asked once, and a cached answer would describe the cache.
    retrievalCache: false,
  });
  const sink = sandbox.chunks;

  const report = await sandbox.ingestion.run();
  if (report.failures.length > 0) {
    throw new Error(
      `${String(report.failures.length)} file(s) failed to ingest: ` +
        report.failures.map((failure) => failure.sourceId).join(", "),
    );
  }

  // Read after ingestion and matched to it by bytes, not by name. A version identifier is the hash
  // of its content, so a file whose bytes changed between the crawl and this read has no match and
  // its citations fail loudly instead of being computed against the wrong text.
  const files = readRepositories(options.repositoryRoot);
  const byVersion = new Map<SourceVersionId, SourceFile>();
  for (const file of files) byVersion.set(formatSourceVersionId(contentHashOf(file.text)), file);

  const graph = buildCallGraph(files);
  const pipeline = sandbox.answering;

  let counter = 0;

  const ask = async (principal: string, query: string): Promise<AssistantAnswer> => {
    counter += 1;
    const outcome = await pipeline.answer({
      requestId: formatRequestId(`rag02_${String(counter)}`),
      principalId: parsePrincipalId(principal, "principal"),
      query,
    });

    const { answer } = outcome.grounding;
    if (answer.abstained) {
      // PRD 9.4: with generation unavailable the answer is the ranked passages, and there are no
      // spans to narrow them to — so each is cited whole, as `chunk` precision. Any other
      // abstention returns no passages and so cites nothing.
      const passages: Citation[] = [];
      for (const passage of outcome.grounding.passages) {
        const stored = await sink.get(passage.chunkId);
        const file = byVersion.get(passage.sourceVersionId);
        if (stored === null || file === undefined) {
          throw new Error(
            `passage ${passage.chunkId} cannot be resolved to a version this assistant read`,
          );
        }
        const lines = linesInVersion(
          file.text,
          passage.sourceVersionId,
          stored.chunk.charStart,
          stored.chunk.charEnd,
        );
        passages.push({
          path: file.path,
          version: passage.sourceVersionId,
          lines,
          rendered: renderLines(file.path, lines),
          precision: "chunk",
          symbols: symbolNamesOf(stored),
        });
      }
      return { answer, message: outcome.grounding.message, citations: passages, related: [] };
    }

    const citations: Citation[] = [];
    const cited = new Map<string, StoredChunk>();

    for (const segment of answer.segments) {
      for (const reference of segment.references) {
        const stored = await sink.get(reference.chunkId);
        const file = byVersion.get(reference.sourceVersionId);
        if (stored === null || file === undefined) {
          throw new Error(
            `citation ${reference.chunkId} cannot be resolved to a version this assistant read`,
          );
        }
        cited.set(stored.chunk.chunkId, stored);

        // The span is relative to the passage the model was shown. When that passage is the chunk
        // byte for byte, the span maps onto the source exactly; when it is not — delimiter
        // neutralisation changed its length — the whole chunk's lines are given and say so.
        const exactStart = stored.chunk.charStart + reference.span.start;
        const exactEnd = stored.chunk.charStart + reference.span.end;
        const shown = stored.text.slice(reference.span.start, reference.span.end);
        const exact = file.text.slice(exactStart, exactEnd) === shown && shown.length > 0;

        const lines = exact
          ? linesInVersion(file.text, reference.sourceVersionId, exactStart, exactEnd)
          : linesInVersion(
              file.text,
              reference.sourceVersionId,
              stored.chunk.charStart,
              stored.chunk.charEnd,
            );

        citations.push({
          path: file.path,
          version: reference.sourceVersionId,
          lines,
          rendered: renderLines(file.path, lines),
          precision: exact ? "span" : "chunk",
          symbols: symbolNamesOf(stored),
        });
      }
    }

    // Related symbols through the call graph. Every edge is within one repository, and the principal
    // could read the cited chunk's repository — so everything listed here is theirs to read.
    const related = [...cited.values()].flatMap((stored) => {
      const file = byVersion.get(stored.chunk.sourceVersionId);
      if (file === undefined) return [];
      return symbolNamesOf(stored).map((name) => {
        const ref = { path: file.path, name };
        return {
          of: `${file.path}#${name}`,
          callers: graph.callersOf(ref),
          callees: graph.calleesOf(ref),
        };
      });
    });

    return { answer, message: outcome.grounding.message, citations, related };
  };

  const ranked = async (principal: string, query: string): Promise<readonly string[]> => {
    counter += 1;
    const outcome = await pipeline.answer({
      requestId: formatRequestId(`rag02_${String(counter)}`),
      principalId: parsePrincipalId(principal, "principal"),
      query,
    });
    return outcome.retrieval.candidates.map((candidate) => candidate.chunkId);
  };

  return {
    ask,
    ranked,
    graph,
    chunks: () => sink.all(),
    files,
    versionOf: (path) => {
      const file = files.find((entry) => entry.path === path);
      return file === undefined ? null : formatSourceVersionId(contentHashOf(file.text));
    },
  };
}
