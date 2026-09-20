/**
 * Cost, computed from a checked-in versioned table (PRD 9.2).
 *
 * Not read back from a provider dashboard, because a cost figure that cannot be attributed to a
 * request cannot be acted on — a monthly invoice tells you the total and nothing about which stage,
 * which query shape, or which retry loop produced it.
 *
 * **The shipped table is empty and an unpriced model throws.** Real per-token prices are facts
 * about vendor pricing and this project does not invent facts, so the table carries version
 * `0-unpriced` and no models until somebody records real ones with a date and a source. The
 * rejected alternative — returning zero for an unknown model — fails silently and in the dangerous
 * direction: every cost budget in PRD 9.3 would pass trivially and the error would surface on an
 * invoice. See ADR 0002.
 */

import { AtlasOpsError } from "@atlasops/contracts";

export interface ModelPrice {
  readonly inputPer1MTokens: number;
  readonly outputPer1MTokens: number;
}

export interface PriceTable {
  /** Stamped into every cost record, so a report can be traced to the prices that produced it. */
  readonly version: string;
  readonly currency: "USD";
  readonly models: Readonly<Record<string, ModelPrice>>;
}

/** What ships. See the file header and ADR 0002. */
export const UNPRICED_TABLE: PriceTable = {
  version: "0-unpriced",
  currency: "USD",
  models: {},
};

export interface CostRecord {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly amountUsd: number;
  /** Which table produced `amountUsd`. Never omitted — a cost without its table is unauditable. */
  readonly priceTableVersion: string;
}

export function costOf(
  table: PriceTable,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): CostRecord {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `inputTokens must be a non-negative number for ${modelId}`,
    );
  }
  if (!Number.isFinite(outputTokens) || outputTokens < 0) {
    throw new AtlasOpsError(
      "VALIDATION",
      `outputTokens must be a non-negative number for ${modelId}`,
    );
  }

  const price = table.models[modelId];
  if (price === undefined) {
    throw new AtlasOpsError(
      "VALIDATION",
      `no price for model "${modelId}" in price table version "${table.version}". Cost accounting ` +
        `stops rather than reporting zero: an unpriced model that costs nothing makes every cost ` +
        `budget in PRD 9.3 pass trivially. Add the model to the table with a source and a date, ` +
        `and bump the table version (ADR 0002).`,
    );
  }

  const amountUsd =
    (inputTokens / 1_000_000) * price.inputPer1MTokens +
    (outputTokens / 1_000_000) * price.outputPer1MTokens;

  return {
    modelId,
    inputTokens,
    outputTokens,
    amountUsd,
    priceTableVersion: table.version,
  };
}

/** Whether a table can price a model, for callers that want to branch rather than catch. */
export function canPrice(table: PriceTable, modelId: string): boolean {
  return table.models[modelId] !== undefined;
}

export function totalCost(records: Iterable<CostRecord>): number {
  let total = 0;
  for (const record of records) total += record.amountUsd;
  return total;
}
