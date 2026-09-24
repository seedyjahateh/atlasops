/**
 * HTTP, as a port.
 *
 * The adapters below this line talk to a provider over HTTP, and a test must never do that. So the
 * transport is an interface with exactly one method, and every test drives a recorded one — which
 * is the same discipline `Sleeper` applies to waiting and `Clock` applies to time, for the same
 * reason: the interesting behaviour is what the adapter does with a response, and a real network
 * call proves none of it while costing money and flaking.
 *
 * **The request carries no key.** Authorisation is a header the adapter sets, and this module never
 * logs a request. A transport that dumped its own input on failure would put the key in a CI log
 * the first time a call failed, which is the ordinary way secrets escape.
 */

import { ModelError } from "./errors.js";

export interface HttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal | undefined;
  /** Milliseconds. The adapter's own deadline, independent of any caller signal. */
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  /**
   * Response headers, names in lower case.
   *
   * Carried because a provider's rate-limit response says how long to wait — `retry-after-ms`,
   * `retry-after` — and a retry schedule that ignores it is guaranteed to fail against any limit
   * longer than its own backoff. The first real load run found exactly that.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpTransport {
  readonly send: (request: HttpRequest) => Promise<HttpResponse>;
}

/**
 * The real one, over `fetch`.
 *
 * A timeout is not the same as a caller cancelling, and both have to work: the caller's signal
 * aborts because somebody gave up waiting, the deadline aborts because the provider did. They are
 * combined rather than chosen between, and the deadline is always present — a request with no
 * deadline is how one stuck socket becomes an exhausted connection pool.
 */
export const fetchTransport: HttpTransport = {
  async send(request: HttpRequest): Promise<HttpResponse> {
    /**
     * A test that reaches the network is a bug, and the standing bar says so: "no test calls a
     * paid API". The rule is easy to keep by convention and easy to break by forgetting to pass a
     * transport, so it is enforced here — a real call under the test runner fails loudly instead
     * of quietly spending money and flaking in CI.
     */
    if (process.env.VITEST !== undefined) {
      throw new Error(
        "fetchTransport was called under the test runner. Tests drive recordingTransport; an " +
          "adapter constructed without a transport would have called the provider for real.",
      );
    }

    const deadline = AbortSignal.timeout(request.timeoutMs);
    const signal =
      request.signal === undefined ? deadline : AbortSignal.any([request.signal, deadline]);

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        signal,
      });
    } catch (cause) {
      // An abort from the deadline is a timeout; anything else is the network being unreachable.
      // Both are retryable, and neither message may carry the request that produced it.
      const timedOut = deadline.aborted;
      throw new ModelError(
        "transport",
        timedOut ? "timeout" : "unavailable",
        timedOut
          ? `no response within ${String(request.timeoutMs)} ms`
          : `request failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, body: await response.text(), headers };
  },
};

export interface RecordedExchange {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RecordingTransport extends HttpTransport {
  /** Every request sent, in order, so a test can assert the wire shape rather than infer it. */
  readonly sent: () => readonly HttpRequest[];
}

/**
 * The in-repo fake: replies from a queue, in order, and refuses to invent one.
 *
 * Running out of recorded replies throws rather than repeating the last one. A fake that keeps
 * answering lets a test assert two calls happened when only one did.
 */
export function recordingTransport(
  exchanges: readonly (RecordedExchange | Error)[],
): RecordingTransport {
  const sent: HttpRequest[] = [];
  let next = 0;

  return {
    send(request: HttpRequest): Promise<HttpResponse> {
      sent.push(request);
      const exchange = exchanges[next];
      next += 1;

      if (exchange === undefined) {
        return Promise.reject(
          new Error(
            `recordingTransport has ${String(exchanges.length)} recorded exchange(s) and was ` +
              `called ${String(next)} time(s)`,
          ),
        );
      }
      if (exchange instanceof Error) return Promise.reject(exchange);
      return Promise.resolve({
        status: exchange.status,
        body: exchange.body,
        headers: exchange.headers ?? {},
      });
    },
    sent: (): readonly HttpRequest[] => [...sent],
  };
}
