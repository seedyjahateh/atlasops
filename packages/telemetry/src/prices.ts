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
  /**
   * Where the figure came from, and when it was read.
   *
   * Required, not documentation. A per-token price is a fact about a vendor's published list on a
   * particular day, and vendors change lists; a number with no source is indistinguishable from a
   * number somebody remembered, which is exactly what PRD section 0 forbids from reaching a cost
   * report. A synthetic table used by a test says so here, which also stops a fixture price ever
   * being mistaken for a real one.
   */
  readonly source: string;
  /** ISO date, `YYYY-MM-DD`, on which `source` showed these figures. */
  readonly retrievedOn: string;
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accepts a table only if every price says where it came from.
 *
 * The types already require the fields; this catches the empty string, which is what a required
 * field degrades into when somebody is in a hurry. A table is built once and read for the life of
 * a report, so the check belongs at construction rather than at every lookup.
 */
export function checkedPriceTable(table: PriceTable): PriceTable {
  for (const [modelId, price] of Object.entries(table.models)) {
    if (price.source.trim().length === 0) {
      throw new AtlasOpsError(
        "VALIDATION",
        `the price for "${modelId}" in table "${table.version}" has no source. A per-token price ` +
          `is a fact about a published list on a day, and one without a citation cannot be ` +
          `defended in a cost report (ADR 0002).`,
        `models.${modelId}.source`,
      );
    }
    if (!ISO_DATE.test(price.retrievedOn)) {
      throw new AtlasOpsError(
        "VALIDATION",
        `the price for "${modelId}" in table "${table.version}" has retrievedOn ` +
          `"${price.retrievedOn}"; expected an ISO date such as 2026-09-24. Prices go stale and a ` +
          `report has to say how stale.`,
        `models.${modelId}.retrievedOn`,
      );
    }
  }
  return table;
}

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
