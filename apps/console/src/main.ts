/**
 * The console process.
 *
 * Binds a socket and serves what `console.ts` renders. Nothing here decides anything.
 */

import { createServer } from "node:http";

import { ConfigError, handleConsole, readConsoleConfig } from "./console.js";

function main(): void {
  const config = readConsoleConfig(process.env, process.argv.slice(2));

  const server = createServer((request, response) => {
    const result = handleConsole(config, request.method ?? "GET", request.url ?? "/");
    response.writeHead(result.status, {
      "content-type": result.contentType,
      "content-length": String(Buffer.byteLength(result.body)),
      // A read-only view over generated documents has no reason to execute anything, embed
      // anything, or be embedded anywhere.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    });
    response.end(result.body);
  });

  server.listen(config.port, () => {
    process.stdout.write(
      `atlasops console on http://127.0.0.1:${String(config.port)} ` +
        `(artefacts from ${config.evidenceDir})\n`,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
}
