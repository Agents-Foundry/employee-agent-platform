// HTTP transport for agents-foundry/runtime/v1 (Architecture V2 Phase C, ADR 0011).
// Pure types and constants. Signing and verification happen with node:crypto on each side.
import type { ArtifactUploadDescriptor } from '../../artifacts.js';
import type { ApprovalRisk, ExecutionError, RuntimeCorrelation } from '../../execution.js';
import type { RuntimeCommand, RuntimeProtocolVersion } from './protocol.js';

/** Workload-identity scheme: every runtime request is signed with the runtime's Ed25519 key. */
export const RUNTIME_AUTH_SCHEME = 'AF-RUNTIME-V1' as const;

export const runtimeAuthHeaders = {
  runtimeId: 'x-af-runtime-id',
  timestamp: 'x-af-runtime-timestamp',
  nonce: 'x-af-runtime-nonce',
  signature: 'x-af-runtime-signature',
} as const;

/** Signed requests older or newer than this are rejected; nonces are kept at least this long. */
export const RUNTIME_REQUEST_MAX_SKEW_MS = 5 * 60_000;

export const runtimeTransportPaths = {
  claim: '/runtime/v1/commands/claim',
  events: '/runtime/v1/events',
  actions: '/runtime/v1/actions',
  execute: '/runtime/v1/actions/execute',
  grant: '/runtime/v1/actions/grant',
  modelReserve: '/runtime/v1/models/reserve',
  modelSettle: '/runtime/v1/models/settle',
  modelCredential: '/runtime/v1/models/credential',
  heartbeat: '/runtime/v1/heartbeat',
  checkpointSave: '/runtime/v1/checkpoints',
  checkpointLoad: '/runtime/v1/checkpoints/load',
  artifactUpload: '/runtime/v1/artifacts',
  /** For execution runtimes, which present the signed grant instead of holding a lease. */
  artifactUploadExecution: '/runtime/v1/artifacts/execution',
} as const;

/**
 * The exact bytes a runtime signs. `bodySha256` is the lowercase hex SHA-256 of the raw request
 * body (of the empty string when there is none), so the signature covers the payload.
 */
export function runtimeSigningInput(request: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    RUNTIME_AUTH_SCHEME,
    request.method.toUpperCase(),
    request.path,
    request.timestamp,
    request.nonce,
    request.bodySha256,
  ].join('\n');
}

/** The runtime's claim on one run (the persisted form of `RuntimeSession`). */
export interface RuntimeLease {
  sessionId: string;
  /** Last runtime event sequence the control plane accepted for the run. */
  runtimeSequence: number;
  leaseExpiresAt: string;
}

/** `POST /runtime/v1/commands/claim` → 200 with this body, or 204 when nothing is pending. */
export interface RuntimeClaimResponse {
  command: RuntimeCommand;
  lease: RuntimeLease;
}

/**
 * A runtime asks the control plane whether it may perform a governed action before invoking
 * the tool that performs it. The control plane decides; the runtime never does (ADR 0005).
 */
export interface RuntimeActionRequest {
  protocol: RuntimeProtocolVersion;
  /** Idempotency key: a retried request returns the original decision. */
  requestId: string;
  correlation: RuntimeCorrelation & { stepId: string; toolCallId: string };
  action: string;
  toolId: string;
  toolVersion: string;
  inputDigest: string;
  /** Human-readable purpose from the runtime. Control-plane-executed actions replace it. */
  summary: string;
  /**
   * The exact action payload, required for actions the control plane executes (Phase D).
   * Its canonical SHA-256 must equal `inputDigest`, which binds any approval to this payload.
   */
  parameters?: Record<string, unknown>;
}

/** Ask the control plane to execute an allowed or approved action it owns. Single use. */
export interface RuntimeActionExecuteRequest {
  protocol: RuntimeProtocolVersion;
  requestId: string;
  correlation: RuntimeCorrelation & { stepId: string; toolCallId: string };
}

/**
 * Ask for a signed execution grant for an allowed or approved action that an execution
 * runtime performs (Phase E, ADR 0013). Same shape as an execute request.
 */
export type RuntimeActionGrantRequest = RuntimeActionExecuteRequest;

export interface RuntimeActionExecution {
  requestId: string;
  status: 'SUCCEEDED' | 'FAILED';
  /** Non-secret identifiers of what was created, for example an issue key and URL. */
  result?: Record<string, string>;
  error?: ExecutionError;
}

export type RuntimeActionDecision =
  | { requestId: string; decision: 'ALLOWED'; risk: ApprovalRisk; reason: string }
  | { requestId: string; decision: 'DENIED'; risk: ApprovalRisk; reason: string }
  | {
      requestId: string;
      decision: 'APPROVAL_REQUIRED';
      risk: ApprovalRisk;
      reason: string;
      /** The run is already paused; it resumes only through a `run.resume` command. */
      approvalId: string;
    };

/**
 * Before every model call the runtime host reserves tokens against the organization's model
 * spending limits (ADR 0021). Without an allowed reservation it makes no call.
 */
export interface RuntimeModelReservationRequest {
  protocol: RuntimeProtocolVersion;
  /** Idempotency key: a retried request returns the original decision. */
  reservationId: string;
  correlation: RuntimeCorrelation;
  provider: string;
  model: string;
  /** Estimated from the prompt's size; the settlement records the provider's count. */
  estimatedInputTokens: number;
  /** The most output the call asks for; the reservation may lower it. */
  maxOutputTokens: number;
}

export type RuntimeModelReservation =
  | {
      reservationId: string;
      decision: 'ALLOWED';
      /** The call must not ask for more output than this. */
      maxOutputTokens: number;
    }
  | {
      reservationId: string;
      decision: 'DENIED';
      code: 'MODEL_BUDGET_EXCEEDED';
      reason: string;
    };

/** After the call: the provider-reported usage (zero if the call failed before any). */
export interface RuntimeModelSettlementRequest {
  protocol: RuntimeProtocolVersion;
  reservationId: string;
  correlation: RuntimeCorrelation;
  inputTokens: number;
  outputTokens: number;
}

export interface RuntimeModelSettlement {
  reservationId: string;
  status: 'SETTLED';
}

/**
 * A runtime names the runs it is executing right now, so their leases stay alive (ADR 0032).
 * A run it no longer holds comes back in `lost`, and the runtime must stop working on it.
 */
export interface RuntimeHeartbeatRequest {
  protocol: RuntimeProtocolVersion;
  runIds: string[];
}

export interface RuntimeHeartbeat {
  held: string[];
  lost: string[];
}

/** What a checkpoint is bound to, checked by the control plane on every save and load. */
export interface RunCheckpointBinding {
  manifestId: string;
  /** SHA-256 of the canonical signed manifest payload. */
  manifestDigest: string;
  workflow: string | null;
  /** The step in progress when the checkpoint was taken, if any. */
  stepId: string | null;
  /** The approval the run is waiting for, if it is paused. */
  approvalId: string | null;
  kernelId: string;
  /** The last runtime event sequence emitted before the checkpoint. */
  runtimeSequence: number;
}

/**
 * Save the next checkpoint of a run (ADR 0032). `version` must be exactly one more than the
 * stored one and `sessionId` must be the run's current lease session, so a runtime that lost
 * the run cannot advance it. `body` is opaque to the control plane.
 */
export interface RuntimeCheckpointSaveRequest {
  protocol: RuntimeProtocolVersion;
  correlation: RuntimeCorrelation;
  sessionId: string;
  version: number;
  binding: RunCheckpointBinding;
  /** SHA-256 of `body`. */
  sha256: string;
  body: string;
}

export interface RuntimeCheckpointAck {
  runId: string;
  version: number;
}

export interface RuntimeCheckpointLoadRequest {
  protocol: RuntimeProtocolVersion;
  correlation: RuntimeCorrelation;
}

/** The latest checkpoint of a run the runtime holds. */
export interface RuntimeCheckpointRecord {
  runId: string;
  version: number;
  binding: RunCheckpointBinding;
  sha256: string;
  body: string;
}

/**
 * Ask for the organization's model credential for a run's model calls (ADR 0034). Only the
 * holder of a running run may ask, and only for the provider its signed manifest names.
 */
export interface RuntimeModelCredentialRequest {
  protocol: RuntimeProtocolVersion;
  correlation: RuntimeCorrelation;
  provider: string;
}

/** Held in the runtime's memory for one call. Never logged, checkpointed or emitted. */
export interface RuntimeModelCredential {
  provider: string;
  apiKey: string;
}

/**
 * An agent runtime uploads an artifact's bytes for a step of a run it holds (ADR 0033). The
 * control plane verifies the size and SHA-256, stores the bytes in its artifact store and
 * returns the reference to register. `content` is base64.
 */
export interface RuntimeArtifactUploadRequest {
  protocol: RuntimeProtocolVersion;
  correlation: RuntimeCorrelation & { stepId: string };
  artifact: ArtifactUploadDescriptor;
  content: string;
}

/** `POST /runtime/v1/events` acknowledgement. */
export interface RuntimeEventAck {
  eventId: string;
  /** Control-plane history sequence assigned to the event. */
  sequence: number;
  duplicate: boolean;
}
