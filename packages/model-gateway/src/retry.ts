/**
 * Retry, with the waiting injected.
 *
 * The behaviour worth testing is the **schedule** — how many attempts, how long between them, and
 * which failures are worth repeating. A test that actually waits proves none of that and makes the
 * suite slow; a test that asserts "it eventually succeeded" would pass for a loop with no backoff
 * at all, which is the failure mode that turns a provider blip into a self-inflicted outage.
 *
 * So `Sleeper` is a port. The recording implementation resolves immediately and keeps the delays it
 * was asked for, which lets a test assert the exact backoff sequence in microseconds of wall time.
 */

import { ModelError } from "./errors.js";

export interface Sleeper {
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export const realSleeper: Sleeper = {
  sleep: (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export interface RecordingSleeper extends Sleeper {
  /** Every delay asked for, in order. Nothing actually waited. */
  readonly delays: () => readonly number[];
}

export function recordingSleeper(): RecordingSleeper {
  const delays: number[] = [];
  return {
    sleep: (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
    delays: (): readonly number[] => [...delays],
  };
}

export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** Cap, so a long attempt budget cannot produce an absurd final wait. */
  readonly maxDelayMs: number;
}

/**
 * The longest a provider's "retry after" is honoured for. Beyond it the call fails and says so,
 * because an answer path that sleeps for as long as a provider asks has no latency budget at all.
 */
export const MAX_REQUESTED_WAIT_MS = 30_000;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

/**
 * Exponential, capped, and deliberately **not** jittered here.
 *
 * Jitter belongs in a real deployment — synchronised retries from many clients are how a recovering
 * provider gets knocked over again. It is left out of this function because it would make the
 * schedule unassertable, and a jitter source is the kind of thing that gets injected at the edge
 * where it can be seeded. The gap is named rather than hidden: see `jitter` below.
 */
export function backoffFor(policy: RetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

export interface Attempted<T> {
  readonly value: T;
  /** How many calls were made. Feeds the `retries` field telemetry records per model span. */
  readonly attempts: number;
}

/**
 * Runs `operation`, retrying only failures that say they are retryable.
 *
 * A non-`ModelError` is never retried. An unexpected exception is a bug in the adapter rather than
 * a transient condition, and repeating it three times turns one stack trace into three.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  sleeper: Sleeper,
  jitter: (delay: number) => number = (delay) => delay,
): Promise<Attempted<T>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      lastError = error;

      const retryable = error instanceof ModelError && error.retryable;
      if (!retryable || attempt === policy.maxAttempts) break;

      // At least as long as the provider asked, when it asked. The first real load run was told
      // "try again in 338ms" and waited 100 ms, then 200 ms, then gave up — a schedule that could
      // not succeed against any limit longer than itself. Capped, so a provider asking for minutes
      // fails loudly instead of stalling a request for as long as it likes.
      const requested = error instanceof ModelError ? (error.retryAfterMs ?? 0) : 0;
      const wait = Math.min(
        Math.max(backoffFor(policy, attempt), requested),
        MAX_REQUESTED_WAIT_MS,
      );
      await sleeper.sleep(jitter(wait));
    }
  }

  throw lastError;
}
