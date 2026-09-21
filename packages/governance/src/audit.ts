/**
 * Authorisation decisions and the audit record (PRD 6.1, 6.6).
 *
 * Two requirements shape this file, and both are structural rather than procedural.
 *
 * **Every authorisation decision is recorded.** `contracts` exports a pure `canRead` predicate;
 * this package deliberately does not re-export it. The only way to reach an authorisation decision
 * through the governance surface is `journal.authorize`, which appends to the journal as it
 * answers. A decision that nobody can prove was made is the thing an audit log exists to prevent.
 *
 * **The record is written before the answer is returned.** PRD 6.6: "an audit log that can be lost
 * on the response path is not an audit log." `releaseAnswer` is the only way to hand an answer
 * back, and it writes first — if the write throws, the answer never leaves.
 */

import {
  AtlasOpsError,
  canRead,
  type AclLabel,
  type ChunkId,
  type ContentHash,
  type GroupId,
  type PrincipalId,
  type RequestId,
  type SourceVersionId,
} from "@atlasops/contracts";
import type { StageTiming } from "@atlasops/telemetry";

import { groupSetHash } from "./groupset.js";
import type { Principal } from "./principal.js";

export type DecisionReason =
  /** The principal holds a group the label lists. */
  | "group-match"
  /** The label lists groups; the principal holds none of them. */
  | "no-group-match"
  /** The label lists nobody. Denies — an empty readable set never means everybody (PRD 6.1). */
  | "empty-acl";

export interface AuthorizationDecision {
  /** What was being authorised: a chunk id, a source id, an index shard. */
  readonly resource: string;
  readonly allowed: boolean;
  readonly reason: DecisionReason;
}

export interface ChunkReference {
  readonly chunkId: ChunkId;
  readonly sourceVersionId: SourceVersionId;
}

export interface AuditRecord {
  readonly requestId: RequestId;
  readonly principalId: PrincipalId;
  /** The resolved group set, by hash rather than by membership list. */
  readonly groupSetHash: ContentHash;
  readonly queryHash: ContentHash;
  /** The compiled permission predicate that went to the indexes (PRD 6.2). */
  readonly predicate: readonly GroupId[];
  /** Everything that entered the prompt, whether or not it was cited. */
  readonly promptChunks: readonly ChunkReference[];
  readonly citedChunks: readonly ChunkReference[];
  readonly decisions: readonly AuthorizationDecision[];
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Null when the models in this request have no price in the table that was in force.
   *
   * Widened from `number` when the answer path was built: the price table ships empty (ADR 0002),
   * and the two alternatives were both worse than an honest null. Recording zero would fabricate a
   * cost — the exact thing that ADR forbids — and throwing would make an unpriced model withhold
   * every answer, turning a missing price list into an outage. A reader of the record can tell
   * "this cost nothing" from "nobody knows what this cost"; a zero cannot.
   */
  readonly costUsd: number | null;
  readonly stageTimings: readonly StageTiming[];
  readonly writtenAt: string;
}

export interface AuditSink {
  readonly write: (record: AuditRecord) => Promise<void>;
}

export interface SealInput {
  readonly promptChunks: readonly ChunkReference[];
  readonly citedChunks: readonly ChunkReference[];
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when the models have no price in the table in force. See `AuditRecord.costUsd`. */
  readonly costUsd: number | null;
  readonly stageTimings: readonly StageTiming[];
  readonly writtenAt: string;
}

export interface AuthorizationJournal {
  readonly principal: Principal;
  readonly groupSetHash: ContentHash;
  /** The compiled predicate: the groups an index query may match on. */
  readonly predicate: readonly GroupId[];
  readonly authorize: (resource: string, label: AclLabel) => boolean;
  readonly decisions: () => readonly AuthorizationDecision[];
  readonly seal: (input: SealInput) => AuditRecord;
}

export function createAuthorizationJournal(input: {
  readonly requestId: RequestId;
  readonly principal: Principal;
  readonly queryHash: ContentHash;
}): AuthorizationJournal {
  const decisions: AuthorizationDecision[] = [];
  const hash = groupSetHash(input.principal.groups);
  let sealed = false;

  return {
    principal: input.principal,
    groupSetHash: hash,
    predicate: input.principal.groups,

    authorize(resource: string, label: AclLabel): boolean {
      if (sealed) {
        throw new AtlasOpsError(
          "VALIDATION",
          `authorisation of "${resource}" was attempted after the audit record was sealed. A ` +
            `decision made after the record exists is a decision the record does not contain.`,
        );
      }

      const allowed = canRead(label, input.principal.groups);
      const reason: DecisionReason =
        label.readableBy.length === 0 ? "empty-acl" : allowed ? "group-match" : "no-group-match";

      decisions.push({ resource, allowed, reason });
      return allowed;
    },

    decisions: (): readonly AuthorizationDecision[] => [...decisions],

    seal(sealInput: SealInput): AuditRecord {
      if (sealed) throw new AtlasOpsError("VALIDATION", "the audit record was sealed twice");
      sealed = true;

      /**
       * A cited chunk that never entered the prompt is not a citation, it is a fabrication — and
       * it is exactly what PRD 7.2's verification pass exists to catch. Catching it here as well
       * costs nothing and means the audit record cannot record an impossible answer.
       */
      const inPrompt = new Set(sealInput.promptChunks.map((chunk) => chunk.chunkId));
      const fabricated = sealInput.citedChunks.filter((chunk) => !inPrompt.has(chunk.chunkId));
      if (fabricated.length > 0) {
        throw new AtlasOpsError(
          "UNSUPPORTED_REFERENCE",
          `the answer cites ${String(fabricated.length)} chunk(s) that never entered the prompt: ` +
            fabricated.map((chunk) => chunk.chunkId).join(", "),
        );
      }

      return {
        requestId: input.requestId,
        principalId: input.principal.id,
        groupSetHash: hash,
        queryHash: input.queryHash,
        predicate: input.principal.groups,
        promptChunks: sealInput.promptChunks,
        citedChunks: sealInput.citedChunks,
        decisions: [...decisions],
        models: sealInput.models,
        inputTokens: sealInput.inputTokens,
        outputTokens: sealInput.outputTokens,
        costUsd: sealInput.costUsd,
        stageTimings: sealInput.stageTimings,
        writtenAt: sealInput.writtenAt,
      };
    },
  };
}

/**
 * The only way to return an answer: the audit is written first.
 *
 * If the sink throws, this throws and the answer is not returned. That is the intended behaviour
 * and not a robustness gap — a governed system that answers while failing to record who asked has
 * lost the property it exists to provide, and the caller should see the failure rather than the
 * answer.
 */
export async function releaseAnswer<T>(
  sink: AuditSink,
  record: AuditRecord,
  answer: T,
): Promise<T> {
  await sink.write(record);
  return answer;
}

export interface RecordingAuditSink extends AuditSink {
  readonly records: () => readonly AuditRecord[];
}

/** The deterministic in-repo sink. No network, no filesystem, no clock. */
export function inMemoryAuditSink(): RecordingAuditSink {
  const written: AuditRecord[] = [];
  return {
    write: (record: AuditRecord): Promise<void> => {
      written.push(record);
      return Promise.resolve();
    },
    records: (): readonly AuditRecord[] => [...written],
  };
}

/** A sink that always fails, for exercising the "answer is withheld" path. */
export function failingAuditSink(reason = "audit store unavailable"): AuditSink {
  return {
    write: (): Promise<void> => Promise.reject(new Error(reason)),
  };
}
