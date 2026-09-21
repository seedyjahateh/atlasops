/**
 * A stand-in generator, so the system is runnable without a provider.
 *
 * **This does no language modelling and nothing it produces is an answer in any useful sense.** It
 * reads the first chunk identifier out of the assembled prompt and cites it, with the passage's own
 * opening as the claim text. It exists because no provider adapter is installed in this repository
 * (PRD 5 puts those behind `model-gateway`'s interfaces, and none is implemented), and an
 * application that could not start without one would be a system nobody can run.
 *
 * It lives here rather than in `model-gateway` because it emits PRD 7.1's answer structure, and
 * that structure is this package's. `model-gateway` sits below `grounding` and must not know what
 * an answer looks like. It lives here rather than in an application because two applications need
 * it, and a stand-in duplicated in two applications is two stand-ins.
 *
 * The naming is deliberate. Anything printed by a system wired to this should be recognisable as
 * not-a-model from the identifier alone, which is why the model id says so.
 */

import type { GenerateRequest, Generator } from "@atlasops/model-gateway";

import { fakeGenerator } from "@atlasops/model-gateway";

export const STAND_IN_MODEL_ID = "stand-in-not-a-model";

/**
 * Cites the first passage it was shown.
 *
 * Reading the identifier out of the prompt is what a real model does — the identifiers are in the
 * prompt precisely so the answer can name one — so this exercises prompt assembly and the
 * verification pass for real, even though the claim text is lifted rather than written.
 */
export function citingStandIn(modelId = STAND_IN_MODEL_ID): Generator {
  return fakeGenerator(modelId, (request: GenerateRequest): string => {
    const chunkId = /chunkId=(\S+)/.exec(request.user)?.[1];
    const sourceVersionId = /sourceVersionId=(\S+)/.exec(request.user)?.[1];
    if (chunkId === undefined || sourceVersionId === undefined) {
      // Nothing was retrieved, or the prompt was not one this stand-in understands. Declining is
      // the honest move: inventing a claim is the failure the whole of PRD 7 exists to prevent.
      return JSON.stringify({ abstain: true });
    }

    const passage = passageAfter(request.user, chunkId);
    if (passage === null) return JSON.stringify({ abstain: true });

    const span = { start: 0, end: Math.min(passage.length, 160) };
    return JSON.stringify({
      segments: [
        {
          text: passage.slice(0, span.end),
          references: [{ chunkId, sourceVersionId, span }],
        },
      ],
    });
  });
}

/**
 * The text of the block a chunk identifier heads.
 *
 * Parsed out of the prompt rather than passed alongside it, because a stand-in that received the
 * candidates out of band would not be exercising prompt assembly at all — and prompt assembly is
 * where the delimiter neutralisation that PRD 6.5 depends on actually happens.
 */
function passageAfter(prompt: string, chunkId: string): string | null {
  const header = prompt.indexOf(`chunkId=${chunkId}`);
  if (header === -1) return null;

  const body = prompt.indexOf("\n", prompt.indexOf("\n", header) + 1);
  const close = prompt.indexOf("PASSAGE>>>", header);
  if (body === -1 || close === -1 || close <= body) return null;

  const passage = prompt.slice(body + 1, close).trim();
  return passage.length === 0 ? null : passage;
}
