/**
 * A thin HTTP client for internal services.
 *
 * Every request carries a deadline. A request with no deadline is how one stuck socket becomes an
 * exhausted connection pool.
 */

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export const DEFAULT_TIMEOUT_MS = 5000;

/** Sends a JSON POST with a deadline, and turns a 5xx into a retryable failure. */
export async function postJson(
  url: string,
  payload: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (response.status >= 500) throw retryableFailure(response.status, body);
  return { status: response.status, body };
}

/** An error the retry helper will repeat. */
export function retryableFailure(status: number, body: string): Error & { retryable: true } {
  return Object.assign(new Error(`upstream ${String(status)}: ${body.slice(0, 200)}`), {
    retryable: true as const,
  });
}
