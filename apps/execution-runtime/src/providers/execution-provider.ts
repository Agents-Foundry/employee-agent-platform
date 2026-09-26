import type { ExecutionOperation, ResourceLimits } from '@agents-foundry/contracts';

export interface WorkspaceHandle {
  id: string;
  /** Absolute directory the operation may touch; nothing outside it. */
  root: string;
  /** Runtime-private directory for HOME/TMP; not reachable through workspace paths. */
  scratch: string;
}

export interface ProducedArtifact {
  name: string;
  type: 'log' | 'test_report';
  mediaType: 'text/plain' | 'application/json';
  content: Buffer;
}

export interface ProviderOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'DENIED';
  exitCode?: number;
  error?: { code: string; message: string };
  /** Bounded text for the model. */
  output: string;
  truncated: boolean;
  artifacts: ProducedArtifact[];
}

/**
 * Where dangerous work runs (ADR 0007). Providers declare the isolation they deliver; a
 * grant that requires stronger isolation than the provider offers is refused before any work.
 */
export interface ExecutionProvider {
  readonly id: string;
  readonly isolation: 'sandboxed' | 'local';
  /** Limits this provider actually enforces; everything else is documented, not assumed. */
  readonly enforces: readonly ('timeout' | 'output' | 'filesystem' | 'environment')[];
  execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome>;
}
