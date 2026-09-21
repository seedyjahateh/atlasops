/**
 * The answer API process.
 *
 * Everything with a decision in it is in `config.ts` and `service.ts`; this file binds a socket,
 * prints what it is, and exits. That split is why there is no test here — there is nothing to test
 * that is not either Node's HTTP server or the two modules beside it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describeApiConfig, readApiConfig, ConfigError } from "./config.js";
import { createAnswerService, handle } from "./service.js";

/** A request body, with a ceiling. An unbounded read is a denial of service with a nice name. */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => {
      resolve(null);
    });
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

async function main(): Promise<void> {
  const config = readApiConfig(process.env, process.argv.slice(2));
  const service = createAnswerService(config);

  const chunks = await service.bootstrap();
  for (const line of describeApiConfig(config)) process.stdout.write(`  ${line}\n`);
  process.stdout.write(`  bootstrapped        ${String(chunks)} chunk(s)\n\n`);

  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      if (body === null) {
        send(response, 413, { error: "request body too large or unreadable" });
        return;
      }

      try {
        const result = await handle(service, {
          method: request.method ?? "GET",
          path: (request.url ?? "/").split("?")[0] ?? "/",
          body,
        });
        send(response, result.status, result.body);
      } catch (error) {
        // An unexpected failure is a 500 and a log line, never a body containing a stack trace —
        // a stack trace in a response is a map of the system handed to whoever asked for it.
        process.stderr.write(`unhandled: ${(error as Error).message}\n`);
        send(response, 500, { error: "internal error" });
      }
    })();
  });

  server.listen(config.port, () => {
    process.stdout.write(`atlasops api listening on http://127.0.0.1:${String(config.port)}\n`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
