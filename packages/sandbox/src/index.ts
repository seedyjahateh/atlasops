/**
 * The public surface of `@atlasops/sandbox`.
 *
 * Layer 9, "sandbox": above `composition`, below the applications and exhibits (ADR 0008). It
 * constructs the platform in memory with stand-in models — the construction `composition`
 * deliberately refuses to do — so that exhibits and demonstrations share one of it rather than
 * each writing their own.
 *
 * Never for a deployment. A deployment constructs real adapters and hands them to `composition`.
 */

export {
  STAND_IN_EMBEDDING,
  STAND_IN_MODELS,
  createSandbox,
  type Sandbox,
  type SandboxOptions,
} from "./sandbox.js";
