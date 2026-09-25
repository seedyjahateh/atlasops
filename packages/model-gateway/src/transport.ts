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

/**
 * A response whose body arrives in pieces, as it does from a provider's streaming endpoint.
 *
 * The body is an iterable of decoded text chunks with no framing guarantee: a chunk may end in the
 * middle of a line, or hold several. The caller does the framing. That is the only honest contract
 * — it is what the network delivers — and a fake that always handed over whole lines would let a
 * parser that breaks on a split line pass every test.
 */
export interface HttpStreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: AsyncIterable<string>;
}

export interface HttpTransport {
  readonly send: (request: HttpRequest) => Promise<HttpResponse>;
  /**
   * The same request, with the body read as it arrives. Optional: a transport that cannot stream
   * leaves it out, and an adapter asked to stream over it refuses at construction.
   */
  readonly stream?: (request: HttpRequest) => Promise<HttpStreamResponse>;
}

/** The body of a streamed response, read to the end. For error responses, which do not stream. */
export async function collectChunks(chunks: AsyncIterable<string>): Promise<string> {
  let body = "";
  for await (const chunk of chunks) body += chunk;
  return body;
}

/**
 * The real one, over `fetch`.
 *
 * A timeout is not the same as a caller cancelling, and both have to work: the caller's signal
 * aborts because somebody gave up waiting, the deadline aborts because the provider did. They are
 * combined rather than chosen between, and the deadline is always present — a request with no
 * deadline is how one stuck socket becomes an exhausted connection pool.
 */
/**
 * A test that reaches the network is a bug, and the standing bar says so: "no test calls a paid
 * API". The rule is easy to keep by convention and easy to break by forgetting to pass a transport,
 * so it is enforced here — a real call under the test runner fails loudly instead of quietly
 * spending money and flaking in CI.
 */
function refuseUnderTestRunner(): void {
  if (process.env.VITEST !== undefined) {
    throw new Error(
      "fetchTransport was called under the test runner. Tests drive recordingTransport; an " +
        "adapter constructed without a transport would have called the provider for real.",
    );
  }
}

interface Opened {
  readonly response: Response;
  readonly deadline: AbortSignal;
}

async function open(request: HttpRequest): Promise<Opened> {
  refuseUnderTestRunner();
  const deadline = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined ? deadline : AbortSignal.any([request.signal, deadline]);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
      signal,
    });
    return { response, deadline };
  } catch (cause) {
    throw failureOf(cause, deadline, request.timeoutMs);
  }
}

/**
 * An abort from the deadline is a timeout; anything else is the network being unreachable. Both
 * are retryable, and neither message may carry the request that produced it.
 */
function failureOf(cause: unknown, deadline: AbortSignal, timeoutMs: number): ModelError {
  const timedOut = deadline.aborted;
  return new ModelError(
    "transport",
    timedOut ? "timeout" : "unavailable",
    timedOut
      ? `no response within ${String(timeoutMs)} ms`
      : `request failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
  );
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

export const fetchTransport: HttpTransport = {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const { response, deadline } = await open(request);
    try {
      return { status: response.status, body: await response.text(), headers: headersOf(response) };
    } catch (cause) {
      throw failureOf(cause, deadline, request.timeoutMs);
    }
  },

  async stream(request: HttpRequest): Promise<HttpStreamResponse> {
    const { response, deadline } = await open(request);
    const body = response.body;

    // The deadline covers the whole stream, not only its first byte: a response that starts and
    // then stalls is the same stuck socket as one that never starts.
    async function* chunks(): AsyncGenerator<string> {
      if (body === null) return;
      const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          yield decoder.decode(read.value, { stream: true });
        }
        const tail = decoder.decode();
        if (tail.length > 0) yield tail;
      } catch (cause) {
        throw failureOf(cause, deadline, request.timeoutMs);
      } finally {
        reader.releaseLock();
      }
    }

    return { status: response.status, headers: headersOf(response), chunks: chunks() };
  },
};

export interface RecordedExchange {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * How a streamed read receives the body, piece by piece. Defaults to `[body]`. Tests split events
   * mid-line here on purpose, because the network does.
   */
  readonly chunks?: readonly string[];
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

  const take = (request: HttpRequest): Promise<RecordedExchange> => {
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
    return Promise.resolve(exchange);
  };

  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const exchange = await take(request);
      return { status: exchange.status, body: exchange.body, headers: exchange.headers ?? {} };
    },
    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
      const exchange = await take(request);
      const pieces = exchange.chunks ?? [exchange.body];
      async function* chunks(): AsyncGenerator<string> {
        for (const piece of pieces) {
          await Promise.resolve();
          yield piece;
        }
      }
      return { status: exchange.status, headers: exchange.headers ?? {}, chunks: chunks() };
    },
    sent: (): readonly HttpRequest[] => [...sent],
  };
}
