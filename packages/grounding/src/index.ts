/**
 * The public surface of `@atlasops/grounding`.
 *
 * Layer 6. It imports `contracts`, `telemetry`, `retrieval`, `governance` and `model-gateway`, and
 * not `ingest`, `indexing` or `evalkit`.
 *
 * There is no exported function that turns a model's text into an answer without verifying it, and
 * no exported function that returns an answer without writing the audit first. `groundAnswer` is
 * the only way through, and it goes out via `releaseAnswer` — so PRD 6.6's "the record is written
 * before the answer is returned" is the shape of this package rather than a rule its callers have
 * to remember.
 */

export {
  SYSTEM_PROMPT,
  assemblePrompt,
  neutraliseDelimiters,
  offeredChunkIds,
  type AssembledPrompt,
  type PromptBlock,
} from "./prompt.js";

export {
  citedText,
  verifyAnswer,
  type VerificationFailure,
  type VerificationFailureKind,
  type VerificationInput,
  type VerificationReport,
} from "./verify.js";

export {
  SUPPORT_DEFAULTS,
  assessSupport,
  type SupportDecision,
  type SupportOutcome,
  type SupportPolicy,
  type ThresholdProvenance,
} from "./support.js";

export {
  groundAnswer,
  type GroundingPorts,
  type GroundingRequest,
  type GroundingResult,
} from "./ground.js";
