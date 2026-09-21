/**
 * The answer pipeline (PRD 10, ADR 0005).
 *
 * Resolve the principal, retrieve, ground, return. It is deliberately short: every decision in it
 * was made in a package below, and the value of this file is that there is exactly one of it. The
 * API serves this object and the evaluation runner measures this object, so a change to a default
 * cannot reach one without reaching the other.
 *
 * **Permission resolution happens here and fails closed.** PRD 9.4 lists one dependency with no
 * degraded mode, and this is it; `resolvePrincipal` throws `ACL_UNRESOLVED` rather than proceeding
 * with an assumed group set, and nothing in this file catches it. Retrieval and grounding never see
 * an unresolved principal, which is what lets them be written as though a principal is always
 * resolved.
 *
 * **It satisfies `evalkit`'s `AnswerSystem` port.** That is not a convenience — it is the reason
 * this package exists (ADR 0005). `asAnswerSystem` is a rename, not an adapter: if it needed to
 * reshape anything, the evaluated object and the served object would be different objects again.
 */

import type { PrincipalId, RequestId } from "@atlasops/contracts";
import type { AnswerSystem, SystemObservation, SystemQuery } from "@atlasops/evalkit";
import { groundAnswer, type GroundingResult, type SupportPolicy } from "@atlasops/grounding";
import { resolvePrincipal } from "@atlasops/governance";
import {
  RETRIEVAL_DEFAULTS,
  retrieve,
  type RetrievalConfig,
  type RetrievalResult,
} from "@atlasops/retrieval";
import { UNPRICED_TABLE } from "@atlasops/telemetry";

import type { AnswerPorts } from "./ports.js";

export interface AnswerRequest {
  readonly requestId: RequestId;
  readonly principalId: PrincipalId;
  readonly query: string;
  /** Defaults to the unselected defaults. An ablation run supplies its arm's config. */
  readonly config?: RetrievalConfig | undefined;
}

export interface AnswerOutcome {
  readonly retrieval: RetrievalResult;
  readonly grounding: GroundingResult;
}

export interface AnswerPipeline {
  readonly name: string;
  readonly answer: (request: AnswerRequest) => Promise<AnswerOutcome>;
  /** The same pipeline, under the name `evalkit` knows it by. See the file header. */
  readonly asAnswerSystem: () => AnswerSystem;
}

export interface AnswerPipelineOptions {
  readonly name?: string;
  readonly config?: RetrievalConfig;
  readonly support?: SupportPolicy;
}

export function createAnswerPipeline(
  ports: AnswerPorts,
  options: AnswerPipelineOptions = {},
): AnswerPipeline {
  const name = options.name ?? "atlasops";
  const baseConfig = options.config ?? RETRIEVAL_DEFAULTS;

  const answer = async (request: AnswerRequest): Promise<AnswerOutcome> => {
    // Fails closed. Every possible fallback is a leak (PRD 9.4), so this is not in a try block.
    const principal = await resolvePrincipal(ports.groups, request.principalId);

    const retrieval = await retrieve(
      {
        lexical: ports.lexical,
        vector: ports.vector,
        embeddings: ports.embeddings,
        reranker: ports.reranker,
        oracle: ports.oracle,
        sleeper: ports.sleeper,
        clock: ports.clock,
        ...(ports.retrievalCache === undefined ? {} : { cache: ports.retrievalCache }),
      },
      {
        query: request.query,
        principal,
        requestId: request.requestId,
        config: request.config ?? baseConfig,
      },
    );

    const grounding = await groundAnswer(
      {
        generator: ports.generator,
        sleeper: ports.sleeper,
        sink: ports.audit,
        prices: ports.prices ?? UNPRICED_TABLE,
        now: ports.now,
      },
      {
        requestId: request.requestId,
        principal,
        retrieval,
        ...(options.support === undefined ? {} : { support: options.support }),
      },
    );

    return { retrieval, grounding };
  };

  return {
    name,
    answer,

    asAnswerSystem: (): AnswerSystem => ({
      name,
      answer: (query: SystemQuery): Promise<SystemObservation> =>
        answer({
          // The harness names a principal by identifier, which is the same thing the API receives
          // from its transport. Neither resolves groups; this pipeline does, once, in one place.
          principalId: query.principal as PrincipalId,
          requestId: requestIdFor(query.itemId),
          query: query.query,
          config: query.config,
        }),
    }),
  };
}

/**
 * A request identifier derived from an evaluation item.
 *
 * Derived rather than random so that a re-run produces the same trace identifiers and two runs can
 * be diffed. The identifier grammar is narrow, so anything outside it is replaced rather than
 * allowed to fail the parse at the far end of a long run.
 */
function requestIdFor(itemId: string): RequestId {
  const slug = itemId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 120);
  return `req_eval-${slug.length > 0 ? slug : "item"}` as RequestId;
}
