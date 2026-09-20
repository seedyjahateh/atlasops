/**
 * The error taxonomy.
 *
 * Every failure in this system is one of a closed set of codes, because the alternative — throwing
 * `Error` with a message and matching on the text — makes it impossible to tell a permission
 * failure from a parse failure at a call site, and those two must never be handled the same way.
 *
 * The codes that matter most are the ones the PRD makes non-negotiable. `ACL_UNRESOLVED` exists
 * because section 6.1 requires a source with no resolvable ACL to fail ingestion loudly rather than
 * default to public. `MIXED_EMBEDDING_MODEL` exists because section 4.4 requires mixed-model
 * queries to be refused rather than silently answered from an index that is quietly broken.
 */

export const ERROR_CODES = [
  /** A value did not match its contract. Carries the path that failed. */
  "VALIDATION",
  /** A source arrived with no resolvable ACL. Ingestion must stop (PRD 6.1). */
  "ACL_UNRESOLVED",
  /** Vectors from more than one embedding model would be compared (PRD 4.4). */
  "MIXED_EMBEDDING_MODEL",
  /** An answer failed the structural verification pass (PRD 7.2). */
  "VERIFICATION_FAILED",
  /** A referenced chunk was not in the retrieved set, or not readable by the principal. */
  "UNSUPPORTED_REFERENCE",
  /** A budget declared in the specification was exceeded (PRD 9.3). */
  "BUDGET_EXCEEDED",
  /**
   * A model could not be called: unavailable, rate-limited, timed out, or refused the request.
   *
   * One code rather than four, with the distinction carried as a `kind` on the error. The caller
   * that matters is PRD 9.4's degraded-mode switch, and it branches on which capability is missing
   * — reranker, vector index, generator — not on why. A taxonomy that splits by cause here would
   * push every one of those call sites to enumerate four cases that all end in the same fallback.
   */
  "MODEL_UNAVAILABLE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AtlasOpsError extends Error {
  public override readonly name: string = "AtlasOpsError";
  public readonly code: ErrorCode;
  /** Where the failure happened, in dotted path form, when the code is `VALIDATION`. */
  public readonly path: string | null;

  public constructor(code: ErrorCode, message: string, path: string | null = null) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

export class ValidationError extends AtlasOpsError {
  public override readonly name = "ValidationError";

  public constructor(path: string, message: string) {
    super("VALIDATION", `${path}: ${message}`, path);
  }
}

export function isAtlasOpsError(value: unknown): value is AtlasOpsError {
  return value instanceof AtlasOpsError;
}
