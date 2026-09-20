/**
 * Identifiers.
 *
 * Two properties are being bought here, and both are load-bearing further up the system.
 *
 * **They are branded**, so a `ChunkId` cannot be passed where a `SourceVersionId` is expected. Every
 * one of them is a string at runtime, and in a system that threads four kinds of identifier through
 * retrieval, caching and citation, the compiler is the only thing that will ever catch the
 * transposition.
 *
 * **A source version's identity is its content, and a chunk's identity is derived from its version
 * and its ordinal.** That is what makes PRD 4.5's re-ingestion determinism testable: running
 * ingestion twice over an unchanged source produces the same identifiers by construction rather
 * than by the pipeline happening to be deterministic. It also means an identifier collision is a
 * content collision, which is the only kind worth worrying about.
 */

import { ValidationError } from "./errors.js";
import { contentHashDigest, requireContentHash, type ContentHash } from "./hash.js";
import { requireString } from "./validate.js";

declare const idBrand: unique symbol;

type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

export type SourceId = Id<"SourceId">;
export type SourceVersionId = Id<"SourceVersionId">;
export type ChunkId = Id<"ChunkId">;
export type PrincipalId = Id<"PrincipalId">;
export type GroupId = Id<"GroupId">;
export type RequestId = Id<"RequestId">;

/**
 * The opaque part of a connector-supplied identifier.
 *
 * Deliberately narrow. A connector that wants to use a URL or a file path as a source identifier
 * must normalise it first, because an identifier containing `/`, `#` or whitespace ends up
 * ambiguous the moment it is embedded in a composite key or a cache key.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function requireSlug(value: unknown, path: string): string {
  const candidate = requireString(value, path);
  if (!SLUG_PATTERN.test(candidate)) {
    throw new ValidationError(
      path,
      `expected a normalised identifier matching ${String(SLUG_PATTERN)}, received "${candidate}"`,
    );
  }
  return candidate;
}

function prefixed<Kind extends string>(
  prefix: string,
  kind: Kind,
): {
  format: (body: string) => Id<Kind>;
  parse: (value: unknown, path: string) => Id<Kind>;
  body: (id: Id<Kind>) => string;
} {
  return {
    format: (body: string): Id<Kind> => `${prefix}${requireSlug(body, kind)}` as Id<Kind>,
    parse: (value: unknown, path: string): Id<Kind> => {
      const candidate = requireString(value, path);
      if (!candidate.startsWith(prefix)) {
        throw new ValidationError(
          path,
          `expected a ${kind} beginning "${prefix}", received "${candidate}"`,
        );
      }
      requireSlug(candidate.slice(prefix.length), path);
      return candidate as Id<Kind>;
    },
    body: (id: Id<Kind>): string => id.slice(prefix.length),
  };
}

const source = prefixed("src_", "SourceId");
export const formatSourceId = source.format;
export const parseSourceId = source.parse;

const principal = prefixed("prn_", "PrincipalId");
export const formatPrincipalId = principal.format;
export const parsePrincipalId = principal.parse;

const group = prefixed("grp_", "GroupId");
export const formatGroupId = group.format;
export const parseGroupId = group.parse;

const request = prefixed("req_", "RequestId");
export const formatRequestId = request.format;
export const parseRequestId = request.parse;

/* -------------------------------------------------------------- content-addressed identifiers */

const SOURCE_VERSION_PREFIX = "sv_";

/** A version is identified by the hash of its bytes. Immutable by construction (PRD 4.1). */
export function formatSourceVersionId(hash: ContentHash): SourceVersionId {
  return `${SOURCE_VERSION_PREFIX}${contentHashDigest(hash)}` as SourceVersionId;
}

export function parseSourceVersionId(value: unknown, path: string): SourceVersionId {
  const candidate = requireString(value, path);
  if (!candidate.startsWith(SOURCE_VERSION_PREFIX)) {
    throw new ValidationError(
      path,
      `expected a SourceVersionId beginning "sv_", received "${candidate}"`,
    );
  }
  const digest = candidate.slice(SOURCE_VERSION_PREFIX.length);
  if (!HEX_64.test(digest)) {
    throw new ValidationError(path, "expected sv_ followed by a 64-character sha256 digest");
  }
  return candidate as SourceVersionId;
}

/** The content hash a version identifier was built from. */
export function sourceVersionContentHash(id: SourceVersionId): ContentHash {
  return `sha256:${id.slice(SOURCE_VERSION_PREFIX.length)}` as ContentHash;
}

const CHUNK_PREFIX = "chk_";
const CHUNK_PATTERN = /^chk_([0-9a-f]{64})_(\d+)$/;

/**
 * Derived from the version and the ordinal, never allocated.
 *
 * The alternative — a random or sequential chunk id — makes re-ingestion produce a different chunk
 * set for identical input, which defeats the determinism test in PRD 4.5 and forces every cache
 * keyed on chunk id to be invalidated on every ingestion run.
 */
export function formatChunkId(sourceVersionId: SourceVersionId, ordinal: number): ChunkId {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new ValidationError(
      "chunkId.ordinal",
      `expected a non-negative integer, received ${String(ordinal)}`,
    );
  }
  const digest = sourceVersionId.slice(SOURCE_VERSION_PREFIX.length);
  return `${CHUNK_PREFIX}${digest}_${String(ordinal)}` as ChunkId;
}

export function parseChunkId(value: unknown, path: string): ChunkId {
  const candidate = requireString(value, path);
  if (!CHUNK_PATTERN.test(candidate)) {
    throw new ValidationError(
      path,
      `expected a ChunkId of the form chk_<64 hex>_<ordinal>, received "${candidate}"`,
    );
  }
  return candidate as ChunkId;
}

/** The version and ordinal a chunk identifier was built from. The inverse of `formatChunkId`. */
export function decomposeChunkId(id: ChunkId): {
  sourceVersionId: SourceVersionId;
  ordinal: number;
} {
  const match = CHUNK_PATTERN.exec(id);
  if (match === null) {
    throw new ValidationError("chunkId", `not a well-formed ChunkId: "${id}"`);
  }
  return {
    sourceVersionId: `${SOURCE_VERSION_PREFIX}${match[1] ?? ""}` as SourceVersionId,
    ordinal: Number(match[2]),
  };
}

export { requireContentHash };
