// agents-foundry/execution/v1 — the contract between an agent runtime and an execution runtime
// (Architecture V2 Phase E, ADR 0007, ADR 0013). Pure types and constants.
import type { ArtifactRegistration } from '../../artifacts.js';
import { canonicalManifest } from '../../manifest.js';
import type {
  ExecutionOperation,
  ExecutionResult,
  ResourceLimits,
  WorkspaceState,
} from '../../execution.js';

export const EXECUTION_PROTOCOL_V1 = 'agents-foundry/execution/v1' as const;
/** Domain separator: a grant can never be mistaken for any other signed document. */
export const EXECUTION_GRANT_KIND = 'agents-foundry/execution-grant/v1' as const;

export const executionPaths = {
  execute: '/execution/v1/operations',
  health: '/execution/v1/health',
} as const;

/** Operation kinds that governed actions may authorize (see the control-plane action registry). */
export type ExecutionOperationKind = ExecutionOperation['kind'];

/**
 * A control-plane-signed, single-use authorization for exactly one operation. The execution
 * runtime trusts nothing else: not the agent runtime, not the model, not the request body.
 */
export interface ExecutionGrantPayload {
  kind: typeof EXECUTION_GRANT_KIND;
  grantId: string;
  /** The governed action request this grant executes. */
  requestId: string;
  action: string;
  correlation: {
    organizationId: string;
    employeeId: string;
    agentId: string;
    threadId: string;
    runId: string;
    stepId: string;
    toolCallId: string;
  };
  operationKind: ExecutionOperationKind;
  /** Canonical SHA-256 of the operation; the runtime must present exactly this operation. */
  operationDigest: string;
  /** From the signed manifest. A provider that cannot deliver it must refuse the grant. */
  isolation: 'sandboxed' | 'local';
  limits: ResourceLimits;
  issuedAt: string;
  expiresAt: string;
}

/** The exact bytes signed for a grant: domain-separated from manifests and every other document. */
export function executionGrantSigningInput(payload: ExecutionGrantPayload): string {
  return `${EXECUTION_GRANT_KIND}\n${canonicalManifest(payload)}`;
}

export interface SignedExecutionGrant {
  payload: ExecutionGrantPayload;
  signature: string;
  algorithm: 'Ed25519';
  keyId: string;
}

export interface ExecuteOperationRequest {
  protocol: typeof EXECUTION_PROTOCOL_V1;
  grant: SignedExecutionGrant;
  operation: ExecutionOperation;
}

export interface ExecuteOperationResponse {
  result: ExecutionResult;
  workspace: { id: string; state: WorkspaceState };
  /** Bounded text for the model (file content, status, summary). Never secrets. */
  output: string;
  truncated: boolean;
  /** Evidence already stored by the execution runtime; the agent runtime registers it on the run. */
  artifacts: ArtifactRegistration[];
}
