/**
 * Top-level symbols, read with the TypeScript compiler's own parser.
 *
 * **A parser, not a pattern.** A regular expression for "function declaration" gets the easy cases
 * and silently misses the rest — an overload, a declaration split across lines, a brace inside a
 * template literal — and a missed boundary here becomes a chunk that spans two functions, which is
 * a citation that points at the wrong code. The compiler's parser is the one thing guaranteed to
 * agree with the compiler about where a declaration starts and ends. ADR 0007 records the
 * dependency.
 *
 * **A symbol's range includes its doc comment.** "Index docs" in RAG-02's summary means the prose
 * written beside the code, and the doc comment is where most of it lives. A range that started at
 * the `function` keyword would put the explanation of a function in no chunk at all.
 */

import ts from "typescript";

export const SYMBOL_KINDS = ["function", "class", "interface", "type", "const", "enum"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export interface CodeSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  /** From the start of the leading doc comment, when there is one. */
  readonly charStart: number;
  readonly charEnd: number;
  readonly exported: boolean;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function describe(statement: ts.Statement): { name: string; kind: SymbolKind }[] {
  if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
    return [{ name: statement.name.text, kind: "function" }];
  }
  if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
    return [{ name: statement.name.text, kind: "class" }];
  }
  if (ts.isInterfaceDeclaration(statement)) {
    return [{ name: statement.name.text, kind: "interface" }];
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return [{ name: statement.name.text, kind: "type" }];
  }
  if (ts.isEnumDeclaration(statement)) {
    return [{ name: statement.name.text, kind: "enum" }];
  }
  if (ts.isVariableStatement(statement)) {
    // One statement can declare several names. They share a range, so they share a chunk, and the
    // chunk is named after all of them rather than the first.
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name)
        ? [{ name: declaration.name.text, kind: "const" as const }]
        : [],
    );
  }
  return [];
}

/**
 * Where a declaration's chunk starts: its own doc comment, or the declaration itself.
 *
 * The compiler attaches every leading doc comment to the next declaration, including a file's
 * header comment — so without this, the first declaration in every file would carry the module's
 * prose as though it were the symbol's own. The first run of this exhibit showed exactly that: an
 * interface cited from line 1 because the file's introduction had been folded into it.
 *
 * The rule is the one a reader applies: a doc comment separated from its declaration by a blank
 * line is about something else. Only a comment that runs straight into the declaration belongs to
 * it.
 */
function startOf(statement: ts.Statement, source: ts.SourceFile): number {
  const declarationStart = statement.getStart(source, false);
  const docs = ts.getJSDocCommentsAndTags(statement).filter(ts.isJSDoc);
  const own = docs.at(-1);
  if (own === undefined) return declarationStart;

  const between = source.text.slice(own.getEnd(), declarationStart);
  const newlines = between.split("\n").length - 1;
  return newlines <= 1 ? own.getStart(source) : declarationStart;
}

export function parseSource(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Every top-level declaration, in source order.
 *
 * Import statements and bare expressions are not symbols and are left out. That leaves bytes of a
 * file in no chunk, which is deliberate: an import line answers no question anybody asks a codebase
 * assistant, and a chunk made of them would be a near-duplicate of every other file's imports.
 */
export function topLevelSymbols(fileName: string, text: string): readonly CodeSymbol[] {
  const source = parseSource(fileName, text);
  const symbols: CodeSymbol[] = [];

  for (const statement of source.statements) {
    const described = describe(statement);
    if (described.length === 0) continue;

    // The symbol's own doc comment, if it has one, and never the file's header. See `startOf`.
    const charStart = startOf(statement, source);
    const charEnd = statement.getEnd();

    for (const entry of described) {
      symbols.push({ ...entry, charStart, charEnd, exported: isExported(statement) });
    }
  }

  return symbols;
}

/**
 * The names a declaration calls.
 *
 * Direct calls by identifier, and method calls by their property name. Deliberately syntactic: this
 * does not resolve which declaration a name refers to, which would need a type checker over the
 * whole program. The call graph pairs names with symbols it has actually seen, so an unresolved
 * name simply produces no edge — a missing edge, never a wrong one.
 */
export function calledNames(fileName: string, text: string, symbol: CodeSymbol): readonly string[] {
  const source = parseSource(fileName, text);
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (node.getStart(source) >= symbol.charEnd || node.getEnd() <= symbol.charStart) return;

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return [...names].sort();
}
