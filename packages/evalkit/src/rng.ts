/**
 * A seeded pseudo-random generator, for the bootstrap (PRD 8.5).
 *
 * "Sampling temperature is zero where supported and seeds are fixed where not."
 *
 * A bootstrap resamples a few thousand times, so it is random by construction — which would make
 * every regression verdict slightly different from the last one, and make "the gate flipped" and
 * "the code changed" indistinguishable. Seeding it makes a comparison reproducible: the same runs
 * and the same seed give the same interval, and a reviewer can re-run the decision rather than
 * taking it on trust. The seed travels on the result for that reason.
 *
 * `Math.random` is deliberately not used. It cannot be seeded, so a verdict computed with it cannot
 * be reproduced, and "we re-ran it and got a different answer" is not a conversation a release gate
 * should ever have.
 *
 * This is mulberry32 — small, fast, well-distributed enough for resampling, and **not
 * cryptographic**. Nothing here needs unpredictability; it needs repeatability.
 */

export interface Rng {
  /** A float in [0, 1). */
  readonly next: () => number;
  /** An integer in [0, bound). */
  readonly below: (bound: number) => number;
}

export function seededRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    below: (bound: number): number => Math.floor(next() * bound),
  };
}
