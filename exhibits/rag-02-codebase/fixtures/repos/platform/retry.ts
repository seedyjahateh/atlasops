/**
 * Retry with capped exponential backoff.
 *
 * Shared platform code: every team may read it, and payments calls it. That call crosses a
 * repository boundary, which is the edge the exhibit's call graph must never expose to a principal
 * who can read only one side of it.
 */

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 2000 };

/** The delay before the given attempt: doubles each time, never above the cap. */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const raw = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

/**
 * Runs an operation until it succeeds or the attempts run out.
 *
 * Only errors marked retryable are retried; anything else is thrown at once, because repeating a
 * malformed request produces the same rejection more slowly.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_POLICY,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === policy.attempts) break;
      await sleep(backoffDelay(policy, attempt));
    }
  }
  throw lastError;
}

/** A failure is retryable when it says so. Unknown errors are not guessed at. */
export function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { retryable?: boolean }).retryable === true
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
