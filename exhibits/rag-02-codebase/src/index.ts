/**
 * The public surface of RAG-02, the Codebase Intelligence Assistant.
 *
 * An exhibit is a leaf (PRD 11.2): nothing imports it — not another exhibit, not an application,
 * not a package — so this surface exists for its own tests and its own command, not for reuse. If
 * something here turns out to be needed elsewhere, the answer is to promote it into a package with
 * an ADR, and the boundary checker makes sure that is the only answer available.
 */

export {
  CODE_CHUNK_TOKENS,
  createAssistant,
  readRepositories,
  type Assistant,
  type AssistantAnswer,
  type AssistantOptions,
  type Citation,
} from "./assistant.js";

export {
  buildCallGraph,
  repositoryOf,
  type CallGraph,
  type SourceFile,
  type SymbolRef,
} from "./callgraph.js";

export {
  chunksForSymbol,
  evaluate,
  loadCodebaseDataset,
  resolveItems,
  type CodebaseDataset,
  type CodebaseItem,
  type CodebaseScores,
  type SymbolLabel,
} from "./evaluate.js";

export {
  VersionMismatch,
  lineRangeOf,
  linesInVersion,
  renderLines,
  type LineRange,
} from "./lines.js";

export { headingFor, symbolAware, type SymbolAwareOptions } from "./strategy.js";

export {
  SYMBOL_KINDS,
  calledNames,
  topLevelSymbols,
  type CodeSymbol,
  type SymbolKind,
} from "./symbols.js";
