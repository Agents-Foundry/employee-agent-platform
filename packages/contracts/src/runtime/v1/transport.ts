// HTTP transport for agents-foundry/runtime/v1 (Architecture V2 Phase C, ADR 0011).
// Pure types and constants. Signing and verification happen with node:crypto on each side.
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

/** `POST /runtime/v1/events` acknowledgement. */
export interface RuntimeEventAck {
  eventId: string;
  /** Control-plane history sequence assigned to the event. */
  sequence: number;
  duplicate: boolean;
}
