import type {
  ExecuteOperationResponse,
  ExecutionOperation,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import {
  EXECUTION_PROTOCOL_V1,
  executionPaths,
} from '../../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { parseExecuteOperationResponse } from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import { RuntimeFailure } from '../errors.js';

export interface ExecutionPort {
  execute(
    grant: SignedExecutionGrant,
    operation: ExecutionOperation,
  ): Promise<ExecuteOperationResponse>;
}

/**
 * Client for an execution runtime (ADR 0013). It carries the control-plane grant; the agent
 * runtime has no authority of its own there. Plain HTTP is accepted only on loopback.
 */
export class ExecutionClient implements ExecutionPort {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = new URL(baseUrl);
    if (
      this.base.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)
    )
      throw new Error('EXECUTION_RUNTIME_HTTPS_REQUIRED');
  }

  async execute(
    grant: SignedExecutionGrant,
    operation: ExecutionOperation,
  ): Promise<ExecuteOperationResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(executionPaths.execute, this.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: EXECUTION_PROTOCOL_V1, grant, operation }),
        redirect: 'error',
        // The runtime enforces the grant's timeout; this only bounds a hung connection.
        signal: AbortSignal.timeout(grant.payload.limits.timeoutMs + 60_000),
      });
    } catch {
      throw new RuntimeFailure(
        'EXECUTION_RUNTIME_UNAVAILABLE',
        'The execution runtime is unreachable.',
        true,
      );
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (!response.ok)
      throw new RuntimeFailure(
        typeof body?.error === 'string' ? body.error : 'EXECUTION_REFUSED',
        `The execution runtime refused the operation (HTTP ${response.status}).`,
      );
    return parseExecuteOperationResponse(body);
  }
}
