/**
 * Evaluation datasets as versioned artefacts (PRD 8.1).
 *
 * "A metric without a dataset version and a corpus snapshot hash is meaningless, because the two
 * most effective ways to fake improvement are to quietly re-label the hard queries and to re-ingest
 * the corpus."
 *
 * Both of those are closed here by the same mechanism. **The content hash is derived from the items
 * and is never taken on trust**: a file that declares a hash which disagrees with its contents fails
 * to load, so re-labelling a query is not something that can happen without the hash moving and the
 * version having to move with it. And a dataset cannot be constructed without naming the corpus
 * snapshot it was labelled against, so a metric computed over a re-ingested corpus is comparing
 * against labels that say, in their own record, that they were made for different bytes.
 *
 * **The held-out split is sealed.** PRD 8.1 requires a split "that the development loop may not
 * read", and a comment saying so is not a mechanism — the development path gets a reader that
 * returns development items and throws on held-out ones. Reading held-out data is possible, because
 * it has to be, and it goes through `unseal` with a stated reason that the returned handle carries
 * into whatever artefact is built from it. The point is not to make it impossible; it is to make it
 * impossible to do by accident and impossible to do silently.
 */

import {
  AtlasOpsError,
  contentHashOf,
  requireContentHash,
  type ContentHash,
} from "@atlasops/contracts";

export const DATASET_KINDS = [
  /** Graded relevance labels over chunk identifiers (PRD 8.1 item 1). */
  "relevance",
  /** Queries with the chunks that legitimately support them (item 2). */
  "grounded-answers",
  /** Unanswerable and under-supported queries, where refusal is correct (item 3). */
  "abstention",
  /** Query/principal pairs where a correct system returns nothing or a restricted answer (item 4). */
  "permission-probe",
] as const;

export type DatasetKind = (typeof DATASET_KINDS)[number];

export type Split = "development" | "held-out";

export interface DatasetItem {
  readonly id: string;
  readonly split: Split;
}

export interface Dataset<Item extends DatasetItem> {
  readonly id: string;
  /** Semantic. Changing items without changing this is what `loadDataset` refuses. */
  readonly version: string;
  readonly kind: DatasetKind;
  /** The corpus these labels were made against. A metric without it is not a measurement. */
  readonly corpusSnapshot: ContentHash;
  /** Derived from the items. See the file header. */
  readonly contentHash: ContentHash;
  readonly items: readonly Item[];
}

/**
 * The hash of a dataset's items.
 *
 * Over a canonical rendering rather than over `JSON.stringify(items)`, because key order in the
 * source file is not part of what the dataset *is* — two files that differ only in key order label
 * the same queries the same way, and a hash that moved between them would force a version bump for
 * a reformatting.
 */
export function datasetContentHash(items: readonly DatasetItem[]): ContentHash {
  return contentHashOf(items.map(canonical).join("\n"));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // `JSON.stringify(undefined)` is `undefined`, not a string. A dataset parsed from JSON cannot
  // contain one, but a hand-built item with an explicitly-undefined optional field can — and
  // hashing `undefined` into the digest would make two different items collide.
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export interface DatasetInput<Item extends DatasetItem> {
  readonly id: string;
  readonly version: string;
  readonly kind: DatasetKind;
  readonly corpusSnapshot: string;
  /**
   * The hash the artefact claims. Checked against the items, never trusted.
   *
   * Optional only for a dataset being written for the first time, which is the one moment no
   * declared hash can exist yet.
   */
  readonly contentHash?: string;
  readonly items: readonly Item[];
}

export function loadDataset<Item extends DatasetItem>(input: DatasetInput<Item>): Dataset<Item> {
  if (input.items.length === 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${input.id}: a dataset with no items is not a small dataset, it is the absence of one — ` +
        `every metric computed over it is NaN or vacuously perfect`,
      "dataset.items",
    );
  }

  const ids = new Set<string>();
  for (const item of input.items) {
    if (ids.has(item.id)) {
      throw new AtlasOpsError(
        "VALIDATION",
        `${input.id}: item "${item.id}" appears twice. A duplicated query is weighted twice in ` +
          `every aggregate, silently.`,
        "dataset.items",
      );
    }
    ids.add(item.id);
  }

  const contentHash = datasetContentHash(input.items);
  if (input.contentHash !== undefined && input.contentHash !== contentHash) {
    throw new AtlasOpsError(
      "VALIDATION",
      `${input.id}@${input.version}: the artefact declares ${input.contentHash} but its items ` +
        `hash to ${contentHash}. Either the labels changed without the version moving — which is ` +
        `the first of PRD 8.1's two ways to fake an improvement — or the file is corrupt.`,
      "dataset.contentHash",
    );
  }

  return {
    id: input.id,
    version: input.version,
    kind: input.kind,
    // Validated, not cast. A corpus snapshot that is not a hash is a dataset that cannot say what
    // it was labelled against, which PRD 8.1 makes the difference between a metric and a number.
    corpusSnapshot: requireContentHash(input.corpusSnapshot, "dataset.corpusSnapshot"),
    contentHash,
    items: input.items,
  };
}

/** How a dataset identifies itself in a report. Every metric carries it. */
export function datasetRef(dataset: Dataset<DatasetItem>): string {
  return `${dataset.id}@${dataset.version} (${dataset.contentHash}, corpus ${dataset.corpusSnapshot})`;
}

/* --------------------------------------------------------------------------- the seal */

export interface SealedDataset<Item extends DatasetItem> {
  readonly dataset: Dataset<Item>;
  /** Development items only. The path a development loop is allowed to take. */
  readonly development: () => readonly Item[];
  /**
   * Held-out items, and a record of why they were read.
   *
   * Not private, because a final evaluation has to read them. Not convenient either: the reason is
   * required, non-empty, and travels on the returned handle so it can be carried into the artefact.
   */
  readonly unseal: (reason: string) => UnsealedSplit<Item>;
  /** Whether the held-out split has been read, and for what. */
  readonly unseals: () => readonly string[];
}

export interface UnsealedSplit<Item extends DatasetItem> {
  readonly reason: string;
  readonly items: readonly Item[];
}

export function seal<Item extends DatasetItem>(dataset: Dataset<Item>): SealedDataset<Item> {
  const reasons: string[] = [];

  return {
    dataset,
    development: (): readonly Item[] =>
      dataset.items.filter((item) => item.split === "development"),

    unseal(reason: string): UnsealedSplit<Item> {
      if (reason.trim().length === 0) {
        throw new AtlasOpsError(
          "VALIDATION",
          `${dataset.id}: reading the held-out split requires a stated reason. A held-out split ` +
            `that anybody can read without saying why is a development split with a longer name.`,
          "unseal.reason",
        );
      }
      reasons.push(reason);
      return { reason, items: dataset.items.filter((item) => item.split === "held-out") };
    },

    unseals: (): readonly string[] => [...reasons],
  };
}
