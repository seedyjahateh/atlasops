/**
 * A call graph that cannot cross a repository boundary.
 *
 * "Who calls `withRetry`?" is the canonical codebase question, and in this fixture it has an answer
 * in a repository most principals may not read: payments calls into platform. A principal who can
 * read only platform asking that question must not learn that `issueRefund` exists — which is PRD
 * 6.4's existence oracle, arriving through a graph edge rather than a retrieved passage.
 *
 * **The boundary is enforced by construction, not by a check.** An edge is recorded only when the
 * caller and the callee are in the same repository, and a repository is exactly one access zone. So
 * every edge the graph holds joins two symbols with the same label, and anybody who may read one end
 * may read the other. There is no filter to forget and no permission check to route around,
 * because the graph never contained the edge.
 *
 * The rejected alternative was to record every edge and filter at query time through `governance`.
 * `canRead` is deliberately not exported from that package (P3): the only authorisation path is the
 * journal, which records each decision. An exhibit that reached around that to filter a graph
 * would be the first unaudited authorisation in the repository.
 *
 * **What it costs.** Cross-repository calls are real and this graph does not have them — not even
 * for a principal entitled to both sides. `crossRepositoryCalls` counts what was dropped so that
 * gap is a number in a report rather than something only this comment knows.
 */

import { calledNames, topLevelSymbols } from "./symbols.js";

export interface SourceFile {
  /** Relative to the corpus root, with `/` separators — `payments/refunds.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface SymbolRef {
  readonly path: string;
  readonly name: string;
}

export interface CallGraph {
  readonly callersOf: (symbol: SymbolRef) => readonly SymbolRef[];
  readonly calleesOf: (symbol: SymbolRef) => readonly SymbolRef[];
  /** Edges that were seen and not recorded, because they crossed a repository boundary. */
  readonly crossRepositoryCalls: number;
}

/** The first path segment. A repository is a top-level directory of the corpus. */
export function repositoryOf(path: string): string {
  return path.split("/")[0] ?? path;
}

function key(symbol: SymbolRef): string {
  return `${symbol.path}\u001f${symbol.name}`;
}

export function buildCallGraph(files: readonly SourceFile[]): CallGraph {
  // Every declared name, by repository. A name is resolved within its caller's repository only;
  // one declared elsewhere is a cross-repository call and produces no edge.
  const declared = new Map<string, Map<string, SymbolRef>>();
  for (const file of files) {
    const repository = repositoryOf(file.path);
    const names = declared.get(repository) ?? new Map<string, SymbolRef>();
    for (const symbol of topLevelSymbols(file.path, file.text)) {
      names.set(symbol.name, { path: file.path, name: symbol.name });
    }
    declared.set(repository, names);
  }

  const allNames = new Set<string>();
  for (const names of declared.values()) for (const name of names.keys()) allNames.add(name);

  const callees = new Map<string, SymbolRef[]>();
  const callers = new Map<string, SymbolRef[]>();
  let crossRepositoryCalls = 0;

  for (const file of files) {
    const repository = repositoryOf(file.path);
    const local = declared.get(repository) ?? new Map<string, SymbolRef>();

    for (const symbol of topLevelSymbols(file.path, file.text)) {
      const caller: SymbolRef = { path: file.path, name: symbol.name };

      for (const name of calledNames(file.path, file.text, symbol)) {
        if (name === symbol.name) continue;
        const callee = local.get(name);

        if (callee === undefined) {
          // Declared in another repository: seen, counted, not recorded. A name declared nowhere
          // in the corpus (a built-in, a library call) is neither.
          if (allNames.has(name)) crossRepositoryCalls += 1;
          continue;
        }

        callees.set(key(caller), [...(callees.get(key(caller)) ?? []), callee]);
        callers.set(key(callee), [...(callers.get(key(callee)) ?? []), caller]);
      }
    }
  }

  return {
    callersOf: (symbol) => callers.get(key(symbol)) ?? [],
    calleesOf: (symbol) => callees.get(key(symbol)) ?? [],
    crossRepositoryCalls,
  };
}
