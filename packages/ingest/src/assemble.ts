/**
 * Drafts become chunks (PRD 4.4).
 *
 * A `ChunkDraft` knows where it is in the text and nothing about where it belongs. This file binds
 * it to its source version and its embedding model, and then hands the result to `parseChunk` —
 * **the same validator that guards the boundary for untrusted input.** Nothing constructs a `Chunk`
 * and trusts itself. The derived-identifier check, the non-empty span check and the mandatory
 * embedding reference in PRD 4.4 are all enforced on the way out of this package, so a chunk that
 * reaches an index has already been through the contract rather than merely satisfied its type.
 *
 * The one check that lives here rather than in `contracts` is the text guard: the text being
 * chunked must hash to the version's content hash. It cannot live in `contracts`, because a chunk
 * does not carry its own text — but chunking the wrong bytes is the failure that produces a
 * perfectly valid chunk set claiming a version it was never derived from, and every offset in it
 * points somewhere plausible and wrong.
 */

import {
  ValidationError,
  contentHashOf,
  formatChunkId,
  parseChunk,
  type Chunk,
  type EmbeddingModelRef,
  type SourceVersion,
} from "@atlasops/contracts";

import { type ChunkStrategy } from "./strategy.js";
import { approximateTokenCounter, type TokenCounter } from "./tokens.js";

export interface ChunkingInput {
  readonly version: SourceVersion;
  /** The bytes this version identifies. Checked, not assumed — see the file header. */
  readonly text: string;
  readonly strategy: ChunkStrategy;
  readonly embedding: EmbeddingModelRef;
  /** Defaults to the approximation. A real tokenizer is one argument. */
  readonly tokenCounter?: TokenCounter;
}

export function chunksFor(input: ChunkingInput): readonly Chunk[] {
  const observed = contentHashOf(input.text);
  if (observed !== input.version.contentHash) {
    throw new ValidationError(
      "chunking.text",
      `the text hashes to ${observed} but version ${input.version.sourceVersionId} is ` +
        `${input.version.contentHash}. Chunking bytes that are not the version's produces a chunk ` +
        `set that validates perfectly and cites offsets into a document nobody has.`,
    );
  }

  const counter = input.tokenCounter ?? approximateTokenCounter;

  return input.strategy.chunk(input.text, counter).map((draft, ordinal) =>
    parseChunk(
      {
        chunkId: formatChunkId(input.version.sourceVersionId, ordinal),
        sourceId: input.version.sourceId,
        sourceVersionId: input.version.sourceVersionId,
        ordinal,
        headingPath: [...draft.headingPath],
        charStart: draft.charStart,
        charEnd: draft.charEnd,
        tokenCount: draft.tokenCount,
        contentHash: contentHashOf(draft.text),
        effectiveDate: input.version.effectiveDate,
        // The label travels with the chunk rather than being looked up at query time. The caller
        // passes the *live* version from the corpus, whose label is current — see ADR 0003.
        acl: input.version.acl,
        embedding: input.embedding,
      },
      `chunk[${String(ordinal)}]`,
    ),
  );
}

/**
 * The text of a chunk, recovered from its source.
 *
 * Trivial, and exported on purpose: it is the operation PRD 7.2's verification pass performs, and
 * having one named function for it means the assumption that a chunk is a contiguous slice is
 * written down in a place a test can hold to account.
 */
export function textOf(chunk: Chunk, text: string): string {
  return text.slice(chunk.charStart, chunk.charEnd);
}
