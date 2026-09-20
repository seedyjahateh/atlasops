/**
 * Validation primitives.
 *
 * Hand-written rather than delegated to a schema library, because this package is declared at
 * layer 0 with zero runtime dependencies (PRD 11.2). That is not asceticism: everything above
 * depends on these types, so a vulnerability or a breaking change in a validator library would
 * reach every module in the system at once, and the validation surface here is small enough that
 * owning it costs less than that exposure.
 *
 * Every failure names the path that failed. A validator that reports "invalid chunk" tells you a
 * chunk was invalid; one that reports `chunk.embedding.dimension: expected a positive integer,
 * received 0` tells you what to fix.
 */

import { ValidationError } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(path, "expected an object");
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(path, "expected a non-empty string");
  }
  return value;
}

export function requireInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(path, "expected an integer");
  }
  return value;
}

export function requireNonNegativeInteger(value: unknown, path: string): number {
  const integer = requireInteger(value, path);
  if (integer < 0)
    throw new ValidationError(path, `expected a non-negative integer, received ${String(integer)}`);
  return integer;
}

export function requirePositiveInteger(value: unknown, path: string): number {
  const integer = requireInteger(value, path);
  if (integer <= 0)
    throw new ValidationError(path, `expected a positive integer, received ${String(integer)}`);
  return integer;
}

export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(path, "expected an array");
  return value;
}

export function requireNonEmptyArray(value: unknown, path: string): unknown[] {
  const array = requireArray(value, path);
  if (array.length === 0) throw new ValidationError(path, "expected at least one element");
  return array;
}

export function requireStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((entry, index) =>
    requireString(entry, `${path}[${String(index)}]`),
  );
}

export function requireLiteral<const T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const candidate = requireString(value, path);
  if (!(allowed as readonly string[]).includes(candidate)) {
    throw new ValidationError(
      path,
      `expected one of ${allowed.join(" | ")}, received "${candidate}"`,
    );
  }
  return candidate as T;
}

/** `null` is a value here, not an absence. JSON round-trips it; `undefined` does not. */
export function requireNullable<T>(
  value: unknown,
  path: string,
  parse: (inner: unknown, innerPath: string) => T,
): T | null {
  if (value === null) return null;
  return parse(value, path);
}

/**
 * An ISO 8601 instant, validated by round-trip rather than by regular expression.
 *
 * `new Date("2026-13-45")` does not throw, it produces an invalid date — so parsing alone proves
 * nothing. Re-serialising and comparing is what catches a string that looks like a timestamp and is
 * not one.
 */
export function requireInstant(value: unknown, path: string): string {
  const candidate = requireString(value, path);
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(path, `expected an ISO 8601 instant, received "${candidate}"`);
  }
  if (parsed.toISOString() !== candidate) {
    throw new ValidationError(
      path,
      `expected a normalised ISO 8601 instant such as ${parsed.toISOString()}, received "${candidate}"`,
    );
  }
  return candidate;
}

/**
 * Reject keys the contract does not declare.
 *
 * Silently ignoring an unknown key is how a typo in a connector becomes a field that is never read
 * and never noticed — `effectiveDat` sits in the corpus for six months and every temporal query is
 * subtly wrong.
 */
export function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(path, `unknown field(s): ${unknown.sort().join(", ")}`);
  }
}
