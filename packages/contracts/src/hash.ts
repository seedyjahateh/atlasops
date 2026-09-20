/**
 * Content hashing, defined once for the whole system.
 *
 * This lives in layer 0 rather than in whichever module first needed it, because determinism is a
 * cross-cutting requirement: PRD 4.5 requires re-ingestion to produce a byte-identical chunk set,
 * PRD 8.1 requires evaluation datasets to be content-hashed, and both are only meaningful if every
 * module hashes the same bytes the same way. Two modules with their own hash helpers is two
 * definitions of "unchanged".
 *
 * `node:crypto` is a platform builtin, not a dependency — the package still installs nothing.
 */

import { createHash } from "node:crypto";

import { ValidationError } from "./errors.js";

declare const contentHashBrand: unique symbol;

/** `sha256:` followed by 64 lowercase hex characters. */
export type ContentHash = string & { readonly [contentHashBrand]: "ContentHash" };

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function contentHashOf(input: string | Uint8Array): ContentHash {
  const digest = createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .digest("hex");
  return `sha256:${digest}` as ContentHash;
}

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
}

export function requireContentHash(value: unknown, path: string): ContentHash {
  if (!isContentHash(value)) {
    throw new ValidationError(path, `expected a content hash of the form sha256:<64 hex>`);
  }
  return value;
}

/** The hex body, without the algorithm prefix. Used where an identifier embeds a hash. */
export function contentHashDigest(hash: ContentHash): string {
  return hash.slice("sha256:".length);
}
