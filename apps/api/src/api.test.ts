/**
 * Answer API tests.
 *
 * The transport is tested through `handle`, which takes a method, a path and a body and returns a
 * status and an object — so every decision the API makes is exercised without binding a socket.
 * `main.ts` is the part that binds, and it contains nothing a test would catch.
 *
 * The assertion that matters most is the one about what the response does *not* contain: the
 * abstention reason distinguishes "you may not see this" from "nothing was found", and a transport
 * that returned it would hand a caller the enumeration oracle PRD 6.4 closes.
 */

import { fileURLToPath } from "node:url";

import { unavailableGenerator } from "@atlasops/model-gateway";
import { describe, expect, it } from "vitest";

import { ConfigError, readApiConfig, describeApiConfig } from "./config.js";
import { createAnswerService, handle } from "./service.js";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus", import.meta.url));

const BASE = {
  ATLASOPS_PORT: "8080",
  ATLASOPS_CORPUS_ROOT: CORPUS,
} as const;

function service() {
  return createAnswerService(readApiConfig(BASE));
}

function post(body: unknown) {
  return { method: "POST", path: "/answer", body: JSON.stringify(body) };
}

describe("configuration", () => {
  it("defaults to the only profile that is implemented", () => {
    const config = readApiConfig({});
    expect(config.profile).toBe("memory");
    expect(config.generator).toBe("stand-in");
    expect(config.port).toBe(8080);
  });

  it("refuses a profile that is not built, and names the ones that are", () => {
    // "Unknown profile" leaves somebody guessing whether they mistyped or whether the adapter
    // simply is not there.
    expect(() => readApiConfig({ ATLASOPS_STORE: "postgres" })).toThrow(
      /not implemented in this build. Installed: memory/,
    );
  });

  it("refuses a port that is not a port", () => {
    expect(() => readApiConfig({ ATLASOPS_PORT: "http" })).toThrow(ConfigError);
    expect(() => readApiConfig({ ATLASOPS_PORT: "70000" })).toThrow(/between 1 and 65535/);
  });

  it("says what it is, including what it is not", () => {
    const described = describeApiConfig(readApiConfig(BASE)).join("\n");
    expect(described).toContain("a restart loses the corpus");
    expect(described).toContain("no provider adapter is installed");
  });
});

describe("routing", () => {
  it("answers a health check", async () => {
    const result = await handle(service(), { method: "GET", path: "/health", body: "" });
    expect(result.status).toBe(200);
  });

  it("refuses an unknown route", async () => {
    const result = await handle(service(), { method: "GET", path: "/admin", body: "" });
    expect(result.status).toBe(404);
  });

  it("refuses a body that is not JSON", async () => {
    const result = await handle(service(), { method: "POST", path: "/answer", body: "{" });
    expect(result.status).toBe(400);
  });

  it("refuses a missing query", async () => {
    const result = await handle(service(), post({ principal: "prn_reader" }));
    expect(result.status).toBe(400);
  });

  it("refuses a principal that is not an identifier", async () => {
    const result = await handle(service(), post({ query: "refunds", principal: "alice" }));
    expect(result.status).toBe(400);
  });
});

describe("answering", () => {
  it("answers from the bootstrapped corpus", async () => {
    const api = service();
    const chunks = await api.bootstrap();
    expect(chunks).toBeGreaterThan(0);

    const result = await handle(api, post({ query: "refund window", principal: "prn_reader" }));
    const body = result.body as { abstained: boolean; citations: unknown[]; message: string };

    expect(result.status).toBe(200);
    expect(body.abstained).toBe(false);
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("writes an audit record for every answer", async () => {
    const api = service();
    await api.bootstrap();
    await handle(api, post({ query: "refund window", principal: "prn_reader" }));

    expect(api.audit.records()).toHaveLength(1);
  });

  it("never returns the abstention reason, on a hit or a miss", async () => {
    // The reason distinguishes permission-excluded from low-support, which is exactly the
    // distinction PRD 6.4 says a caller must not be able to make. The response carries the
    // message and not the reason, and the key set is asserted rather than the absence of one
    // name, so a field added later has to be considered rather than merely not called "reason".
    const api = service();
    await api.bootstrap();

    const expected = ["abstained", "citations", "degraded", "message", "requestId"];
    for (const query of ["refund window", "photosynthesis"]) {
      const result = await handle(api, post({ query, principal: "prn_reader" }));
      expect(Object.keys(result.body as Record<string, unknown>).sort()).toEqual(expected);
    }
  });

  it("answers something to any query, because the stand-in embedder has no meaning", async () => {
    // Worth an assertion rather than a footnote. `deterministicVector` derives a vector from a
    // hash, so cosine between an unrelated query and a passage is noise rather than zero, and the
    // dense arm returns candidates for a query the corpus cannot answer. Nothing this wiring
    // produces is evidence about retrieval quality, and the README says so where somebody
    // deploying will read it.
    const api = service();
    await api.bootstrap();

    const result = await handle(api, post({ query: "photosynthesis", principal: "prn_reader" }));
    expect((result.body as { abstained: boolean }).abstained).toBe(false);
  });

  it("returns ranked passages and no prose when generation is unavailable (PRD 9.4)", async () => {
    // Not retryable, so the real sleeper in this service never waits.
    const api = createAnswerService(readApiConfig(BASE), {
      generator: unavailableGenerator("invalid-request"),
    });
    await api.bootstrap();

    const result = await handle(api, post({ query: "refund window", principal: "prn_reader" }));
    const body = result.body as {
      abstained: boolean;
      citations: { chunkId: string }[];
      degraded: string[];
      message: string;
    };

    expect(result.status).toBe(200);
    expect(body.abstained).toBe(true);
    expect(body.degraded).toContain("generation-unavailable");
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.message).toMatch(/most relevant passages/);
    // Still the same key set: the degraded mode adds no field, so it adds no way to leak.
    expect(Object.keys(body).sort()).toEqual([
      "abstained",
      "citations",
      "degraded",
      "message",
      "requestId",
    ]);
  });

  it("answers nothing to a principal the resolver does not know", async () => {
    // Group resolution has no degraded mode (PRD 9.4). An unknown principal is a resolution
    // failure, not an empty group set, and the API reports it as unavailable rather than as an
    // empty answer that looks like a clean miss.
    const api = service();
    await api.bootstrap();

    const result = await handle(api, post({ query: "refund window", principal: "prn_stranger" }));
    expect(result.status).toBe(503);
  });
});
