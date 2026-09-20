/**
 * Model failures, classified by what the caller should do about them.
 *
 * The classification is `retryable` first and `kind` second, because those are two different
 * questions answered by two different callers. The retry loop asks "should I try again"; PRD 9.4's
 * degraded-mode switch asks "is this capability gone, and can I serve without it". Collapsing them
 * into one enum forces every call site to re-derive one from the other.
 *
 * A rate-limit is retryable. An invalid request is not — retrying a malformed prompt produces the
 * same rejection more slowly, and the attempt budget is spent on a call that cannot succeed.
 */

import { AtlasOpsError } from "@atlasops/contracts";

export const MODEL_FAILURE_KINDS = [
  "unavailable",
  "rate-limited",
  "timeout",
  "invalid-request",
] as const;

export type ModelFailureKind = (typeof MODEL_FAILURE_KINDS)[number];

const RETRYABLE: ReadonlySet<ModelFailureKind> = new Set<ModelFailureKind>([
  "unavailable",
  "rate-limited",
  "timeout",
]);

export class ModelError extends AtlasOpsError {
  public override readonly name = "ModelError";
  public readonly kind: ModelFailureKind;
  public readonly retryable: boolean;
  /** Which capability failed, so a degraded-mode decision does not have to parse a message. */
  public readonly capability: string;

  public constructor(capability: string, kind: ModelFailureKind, message: string) {
    super("MODEL_UNAVAILABLE", `${capability} ${kind}: ${message}`);
    this.capability = capability;
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
  }
}

export function isModelError(value: unknown): value is ModelError {
  return value instanceof ModelError;
}
