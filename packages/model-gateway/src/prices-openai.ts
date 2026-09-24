/**
 * Real prices, with a citation and a date on every line.
 *
 * ADR 0002 shipped the price table empty because "real vendor prices are facts this repository does
 * not hold". This file is the other half of that decision arriving: the facts were read from the
 * vendor's published list, and every entry carries the URL and the date it was read, so a cost
 * report can be checked rather than believed. Nothing here was recalled from memory.
 *
 * **The table version encodes the date, not a sequence number.** A price list is a snapshot of a
 * vendor's pricing on a day; `openai-2026-09-24` says which day, and a cost record stamped with it
 * can be re-derived. A version like `2` would say only that somebody edited the file.
 *
 * **Embedding models are priced on input alone.** The published list shows no output price for
 * them, because they emit no tokens — so `outputPer1MTokens` is 0, which is a real zero rather than
 * the fabricated one ADR 0002 refused. An embedding call that somehow reported output tokens would
 * be priced at zero for them, and the adapter reports none, so no cost is silently lost.
 *
 * When a price changes, add a new table and leave this one alone. Reports already written cite this
 * version; editing it in place would rewrite their history.
 */

import { checkedPriceTable, type PriceTable } from "@atlasops/telemetry";

const SOURCE = "https://developers.openai.com/api/docs/pricing";
const READ_ON = "2026-09-24";

function published(
  inputPer1MTokens: number,
  outputPer1MTokens: number,
): {
  readonly inputPer1MTokens: number;
  readonly outputPer1MTokens: number;
  readonly source: string;
  readonly retrievedOn: string;
} {
  return { inputPer1MTokens, outputPer1MTokens, source: SOURCE, retrievedOn: READ_ON };
}

/**
 * The standard tier, in USD per million tokens, as published on {@link SOURCE} on {@link READ_ON}.
 *
 * Batch and cached-input tiers are deliberately absent. They are real and cheaper, and quoting them
 * for a request that did not use them would understate cost — the discount has to be earned by the
 * call, not by the table.
 */
export const OPENAI_PRICE_TABLE: PriceTable = checkedPriceTable({
  version: `openai-${READ_ON}`,
  currency: "USD",
  models: {
    "text-embedding-3-small": published(0.02, 0),
    "text-embedding-3-large": published(0.13, 0),
    "gpt-4.1-mini": published(0.4, 1.6),
    "gpt-4o-mini": published(0.15, 0.6),
    "gpt-5-mini": published(0.25, 2.0),
  },
});

/** The models this build is configured to use, so a run can state them without repeating strings. */
export const OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const OPENAI_DEFAULT_EMBEDDING_DIMENSION = 1536;
export const OPENAI_DEFAULT_GENERATION_MODEL = "gpt-4.1-mini";
