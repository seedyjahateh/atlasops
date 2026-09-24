/**
 * The corpus inventory: every chunk identifier the example corpus produces, pinned.
 *
 * P14b has to label graded relevance over chunk identifiers, and a chunk identifier is derived from
 * its source version and its ordinal — so it is not something a person can write down from reading
 * the Markdown. This generates the list, with each chunk's zone, offsets and opening words, which
 * is what makes labelling possible at all.
 *
 * **It is generated and checked, never hand-maintained.** `--check` fails when the committed
 * inventory disagrees with a fresh ingestion, and `pnpm verify` runs it. Without that, editing a
 * corpus document would silently invalidate every label pointing into it: the identifiers would
 * move, the labels would point at chunks that no longer exist, and every metric would still
 * compute — quietly measuring a smaller corpus.
 *
 * **The snapshot hash and the chunking settings come from `@atlasops/composition`**, the same
 * values `apps/eval-runner` uses. Two implementations of "which corpus is this" agree until they
 * do not, and the failure would be a dataset pin nobody could explain.
 *
 * It lives under `tools/` because it produces an artefact rather than serving traffic, like the
 * boundary checker beside it. That directory is outside the graph the boundary checker scans, which
 * is a hole named in ADR 0006 rather than one this file pretends does not exist.
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CORPUS_CHUNKING, corpusSnapshotOf, createIngestionPipeline } from "@atlasops/composition";
import { formatGroupId, parsePrincipalId } from "@atlasops/contracts";
import { inMemoryCorpusStore } from "@atlasops/corpus";
import { currentSchema, inMemoryLexicalIndex, inMemoryVectorIndex } from "@atlasops/indexing";
import {
  aclFromManifest,
  filesystemConnector,
  inMemoryChunkSink,
  loadAclManifest,
  structureAware,
  type StoredChunk,
} from "@atlasops/ingest";
import {
  createEmbeddingGateway,
  deterministicVector,
  inMemoryEmbeddingCache,
  realSleeper,
  type EmbedRequest,
  type EmbedResult,
  type Embedder,
} from "@atlasops/model-gateway";
import { systemClock } from "@atlasops/telemetry";

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(here, "..", "..");
const CORPUS_ROOT = join(REPOSITORY_ROOT, "examples", "corpus");
const ACL_MANIFEST = join(REPOSITORY_ROOT, "examples", "corpus.acl.json");
const INVENTORY_PATH = join(REPOSITORY_ROOT, "examples", "corpus.inventory.json");

/**
 * The embedding is irrelevant to what this records and is named anyway.
 *
 * Chunk identifiers depend on the source version and the ordinal, not on the vectors — but an
 * inventory that did not say which embedder ran would invite the reading that these vectors are
 * somebody's real ones.
 */
const EMBEDDING = { id: "stand-in-embedder", dimension: 64 };

const standInEmbedder: Embedder = {
  model: EMBEDDING,
  embed: (request: EmbedRequest): Promise<EmbedResult> =>
    Promise.resolve({
      model: EMBEDDING,
      vectors: request.texts.map((text) => deterministicVector(text, EMBEDDING.dimension)),
      usage: { inputTokens: request.texts.length, outputTokens: 0 },
    }),
};

export interface InventoryChunk {
  readonly chunkId: string;
  readonly ordinal: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenCount: number;
  /** The first words of the chunk, so a labeller can grade without opening the file. */
  readonly opens: string;
}

export interface InventorySource {
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly readableBy: readonly string[];
  readonly existence: string;
  readonly chunks: readonly InventoryChunk[];
}

export interface Inventory {
  readonly corpusSnapshot: string;
  readonly chunking: typeof CORPUS_CHUNKING;
  readonly embedder: string;
  readonly sources: readonly InventorySource[];
}

function opensWith(chunk: StoredChunk): string {
  const flattened = chunk.text.replaceAll(/\s+/g, " ").trim();
  return flattened.length <= 90 ? flattened : `${flattened.slice(0, 89)}…`;
}

export async function buildInventory(): Promise<Inventory> {
  const store = inMemoryCorpusStore();
  const schema = currentSchema(EMBEDDING);
  const lexical = inMemoryLexicalIndex(schema);
  const vector = inMemoryVectorIndex(schema);
  const cache = inMemoryEmbeddingCache();
  const group = formatGroupId("corpus-inventory");
  const record = inMemoryChunkSink();

  const ingestion = createIngestionPipeline(
    {
      store,
      lexical,
      vector,
      embeddings: createEmbeddingGateway(standInEmbedder, { sleeper: realSleeper, cache }),
      sleeper: realSleeper,
      clock: systemClock,
      connector: filesystemConnector({
        root: CORPUS_ROOT,
        strategy: structureAware(CORPUS_CHUNKING),
        aclFor: aclFromManifest(loadAclManifest(ACL_MANIFEST)),
        now: () => new Date().toISOString(),
      }),
      // A recording sink rather than the indexes. `indexing` deliberately exposes no unfiltered
      // accessor (P7) — that is what makes its pre-filter the only read path — and this tool needs
      // to read every chunk, including the ones no principal here may see. Writing to a sink the
      // tool owns keeps that decision intact instead of arguing with it.
      chunks: record,
      embeddingCache: cache,
    },
    { orderedBy: { id: parsePrincipalId("prn_corpus_inventory", "inventory"), groups: [group] } },
  );

  const report = await ingestion.run();
  if (report.failures.length > 0) {
    throw new Error(
      `the crawl failed on ${String(report.failures.length)} source(s): ` +
        `${report.failures.map((failure) => failure.sourceId).join(", ")}. An inventory over a ` +
        `partial crawl would pin a corpus nobody can reproduce.`,
    );
  }

  const bySource = new Map<string, StoredChunk[]>();
  for (const chunk of await record.all()) {
    const existing = bySource.get(chunk.chunk.sourceId) ?? [];
    existing.push(chunk);
    bySource.set(chunk.chunk.sourceId, existing);
  }

  const sources: InventorySource[] = [];
  for (const sourceId of store.sources()) {
    const version = store.liveVersion(sourceId);
    if (version === null) continue;

    const chunks = [...(bySource.get(sourceId) ?? [])].sort(
      (a, b) => a.chunk.ordinal - b.chunk.ordinal,
    );

    sources.push({
      sourceId,
      sourceVersionId: version.sourceVersionId,
      readableBy: [...version.acl.readableBy],
      existence: version.acl.existence,
      chunks: chunks.map((stored) => ({
        chunkId: stored.chunk.chunkId,
        ordinal: stored.chunk.ordinal,
        charStart: stored.chunk.charStart,
        charEnd: stored.chunk.charEnd,
        tokenCount: stored.chunk.tokenCount,
        opens: opensWith(stored),
      })),
    });
  }

  return {
    corpusSnapshot: corpusSnapshotOf(store),
    chunking: CORPUS_CHUNKING,
    embedder: EMBEDDING.id,
    sources,
  };
}

export function renderInventory(inventory: Inventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export const INVENTORY_FILE = INVENTORY_PATH;

/** Writes the inventory and returns what it wrote, so the command and a test agree on one path. */
export function writeInventory(inventory: Inventory): string {
  const rendered = renderInventory(inventory);
  writeFileSync(INVENTORY_PATH, rendered, "utf8");
  return rendered;
}
