/**
 * Checks the labels against the corpus they claim to describe.
 *
 * `loadDataset` already refuses a file whose declared hash disagrees with its items — that closes
 * PRD 8.1's first way to fake an improvement, quietly re-labelling. It cannot close the second one,
 * because it has never seen the corpus. These checks do.
 *
 * Four things are verified, and each of them is a mistake I could make while labelling:
 *
 * 1. **The snapshot pin matches the corpus on disk.** Otherwise the labels describe a corpus that
 *    no longer exists, and every metric computes happily over the wrong denominator.
 * 2. **Every chunk identifier exists.** A label pointing at a chunk that is gone is not an error
 *    anywhere downstream: recall simply never finds it, and the system looks worse than it is.
 * 3. **Every forbidden chunk really is forbidden to that principal.** A probe that lists a chunk
 *    the principal may read would count an ordinary retrieval as a leak — the gate would fail for
 *    the wrong reason, and the natural response would be to loosen the gate.
 * 4. **Every chunk labelled relevant or supporting really is readable by that principal.** This is
 *    the mirror mistake and the more dangerous one: a relevance label on material the principal
 *    cannot see asks the system to retrieve something the pre-filter is built to withhold, so
 *    obeying PRD 6.2 would score as a miss. A dataset can quietly demand a leak.
 */

export interface InventoryChunkRef {
  readonly chunkId: string;
}

export interface InventorySourceRef {
  readonly sourceId: string;
  readonly readableBy: readonly string[];
  readonly existence: string;
  readonly chunks: readonly InventoryChunkRef[];
}

export interface InventoryRef {
  readonly corpusSnapshot: string;
  readonly sources: readonly InventorySourceRef[];
}

export interface LabelledItem {
  readonly id: string;
  readonly principal: string;
  /** Chunks the item says the principal should receive. */
  readonly wanted: readonly string[];
  /** Chunks the item says the principal must never receive. */
  readonly forbidden: readonly string[];
}

export interface DatasetUnderCheck {
  readonly name: string;
  readonly corpusSnapshot: string;
  readonly items: readonly LabelledItem[];
}

export interface Problem {
  readonly dataset: string;
  readonly item: string;
  readonly message: string;
}

/** Which source each chunk belongs to, and who may read it. */
function ownership(inventory: InventoryRef): Map<string, InventorySourceRef> {
  const owner = new Map<string, InventorySourceRef>();
  for (const source of inventory.sources) {
    for (const chunk of source.chunks) owner.set(chunk.chunkId, source);
  }
  return owner;
}

export function checkDatasets(
  datasets: readonly DatasetUnderCheck[],
  inventory: InventoryRef,
  memberships: Readonly<Record<string, readonly string[]>>,
): readonly Problem[] {
  const problems: Problem[] = [];
  const owner = ownership(inventory);

  const readable = (principal: string, source: InventorySourceRef): boolean => {
    const groups = memberships[principal] ?? [];
    return source.readableBy.some((group) => groups.includes(group));
  };

  for (const dataset of datasets) {
    if (dataset.corpusSnapshot !== inventory.corpusSnapshot) {
      problems.push({
        dataset: dataset.name,
        item: "(dataset)",
        message:
          `is pinned to ${dataset.corpusSnapshot} and the corpus is ${inventory.corpusSnapshot}. ` +
          `The labels describe a corpus that is no longer on disk, and every metric over them ` +
          `would compute against the wrong denominator (PRD 8.1).`,
      });
    }

    for (const item of dataset.items) {
      if (memberships[item.principal] === undefined) {
        problems.push({
          dataset: dataset.name,
          item: item.id,
          message:
            `names the principal "${item.principal}", who is in no group map entry. Group ` +
            `resolution fails closed, so every run of this item would error rather than measure.`,
        });
      }

      for (const chunkId of [...item.wanted, ...item.forbidden]) {
        if (!owner.has(chunkId)) {
          problems.push({
            dataset: dataset.name,
            item: item.id,
            message:
              `labels ${chunkId}, which no longer exists in the corpus. Nothing downstream would ` +
              `report this: recall simply never finds it and the system scores worse than it is.`,
          });
        }
      }

      for (const chunkId of item.forbidden) {
        const source = owner.get(chunkId);
        if (source === undefined) continue;
        if (readable(item.principal, source)) {
          problems.push({
            dataset: dataset.name,
            item: item.id,
            message:
              `says ${item.principal} must never see ${chunkId}, but it belongs to ` +
              `${source.sourceId}, which that principal may read. An ordinary retrieval would be ` +
              `counted as a leak, the gate would fail for the wrong reason, and the obvious ` +
              `response would be to loosen the gate.`,
          });
        }
      }

      for (const chunkId of item.wanted) {
        const source = owner.get(chunkId);
        if (source === undefined) continue;
        if (!readable(item.principal, source)) {
          problems.push({
            dataset: dataset.name,
            item: item.id,
            message:
              `expects ${item.principal} to be given ${chunkId} from ${source.sourceId}, which ` +
              `that principal may not read. A dataset must not ask the system to retrieve what ` +
              `PRD 6.2 requires it to withhold — obeying the pre-filter would score as a miss.`,
          });
        }
      }
    }
  }

  return problems;
}
