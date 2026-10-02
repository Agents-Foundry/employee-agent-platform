import type {
  ArtifactRetentionPolicy,
  ExecutionOperation,
  ResourceLimits,
} from '@agents-foundry/contracts';
import type { CheckoutCredential } from '../credential-client.js';

export interface WorkspaceHandle {
  id: string;
  /** Absolute directory the operation may touch; nothing outside it. */
  root: string;
  /** Runtime-private directory for HOME/TMP; not reachable through workspace paths. */
  scratch: string;
}

export interface ProducedArtifact {
  name: string;
  type:
    | 'log'
    | 'test_report'
    | 'console_log'
    | 'network_log'
    | 'screenshot'
    | 'playwright_trace'
    | 'video';
  mediaType: string;
  content: Buffer;
  /** How long the evidence is kept; 30 days when the provider does not say. */
  retention?: ArtifactRetentionPolicy;
}

/** Measurements of one operation, for telemetry. Numbers only. */
export interface OperationMeasurements {
  /** Time spent preparing the sandbox (network, egress proxy) before the operation started. */
  sandboxStartupMs?: number;
  /** Connections the egress proxy refused. */
  egressDenied?: number;
}

export interface ProviderOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'DENIED';
  exitCode?: number;
  error?: { code: string; message: string };
  /** Bounded text for the model. */
  output: string;
  truncated: boolean;
  artifacts: ProducedArtifact[];
  measurements?: OperationMeasurements;
}

/** What the execution service hands a provider beyond the operation itself. */
export interface OperationContext {
  /**
   * A credential redeemed for exactly this `git.checkout` (ADR 0031). Providers use it only
   * for that checkout's network requests and must never write it anywhere.
   */
  credential?: CheckoutCredential;
}

export type EnforcedLimit =
  'timeout' | 'output' | 'filesystem' | 'environment' | 'cpu' | 'memory' | 'processes' | 'network';

/**
 * Where dangerous work runs (ADR 0007). Providers declare the isolation they deliver; a
 * grant that requires stronger isolation than the provider offers is refused before any work.
 */
export interface ExecutionProvider {
  readonly id: string;
  readonly isolation: 'sandboxed' | 'local';
  /** Limits this provider actually enforces; everything else is documented, not assumed. */
  readonly enforces: readonly EnforcedLimit[];
  execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
    context?: OperationContext,
  ): Promise<ProviderOutcome>;
}
