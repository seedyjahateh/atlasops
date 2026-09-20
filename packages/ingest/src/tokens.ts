/**
 * Token counting, as a dependency.
 *
 * **The default counter is an estimate and is named as one.** A real token count is a property of a
 * specific model's tokenizer, and this repository does not hold one. Shipping a character-ratio
 * approximation under a name like `countTokens` would put a number that is not a token count into
 * PRD 4.4's `tokenCount` field, from where it would reach cost arithmetic, budget assertions and
 * eventually a published figure — and nothing downstream would be able to tell it apart from a
 * measured one.
 *
 * So the counter is a port. The chunker takes one, the default is called
 * `approximateTokenCounter`, and swapping in a real tokenizer is one argument. What the estimate is
 * allowed to do is decide where to cut: an approximate budget produces slightly uneven chunks,
 * which costs retrieval quality nothing measurable. What it is not allowed to do is be reported.
 * Billing token counts come from the provider's own usage record through `model-gateway`, never
 * from here.
 */

export type TokenCounter = (text: string) => number;

/**
 * Roughly four characters per token, which is the commonly cited English ratio.
 *
 * Deliberately crude, deliberately deterministic, and deliberately not a tokenizer. It is the same
 * ratio `model-gateway`'s fake uses, so a chunk's estimated size and the fake's estimated usage
 * agree with each other — which keeps the two layers' test fixtures consistent without either of
 * them claiming accuracy.
 */
export const approximateTokenCounter: TokenCounter = (text: string): number =>
  text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
