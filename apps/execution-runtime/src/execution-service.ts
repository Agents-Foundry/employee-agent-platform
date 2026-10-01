import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ArtifactRegistration,
  CredentialReleaseOutcome,
  ExecuteOperationResponse,
} from '@agents-foundry/contracts';
import { parseExecuteOperationRequest } from '../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import type { ExecutionArtifactStore } from './artifact-store.js';
import {
  CredentialRefused,
  type CheckoutCredential,
  type CredentialSource,
} from './credential-client.js';
import { GrantRejected, type GrantVerifier } from './grant-verifier.js';
import { inside } from './providers/local-provider.js';
import type { ExecutionProvider } from './providers/execution-provider.js';
import type { StateStore } from './state-store.js';

export class ExecutionRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ExecutionServiceOptions {
  verifier: GrantVerifier;
  provider: ExecutionProvider;
  state: StateStore;
  artifacts: ExecutionArtifactStore;
  /** Root under which each workspace gets its own directory. */
  workspaceRoot: string;
  /**
   * Accept grants that require a sandbox on a provider that cannot deliver one. Development
   * only; off by default so a misconfigured deployment fails closed.
   */
  allowUnsandboxed?: boolean;
  /**
   * Redeems repository credential leases from the control plane (ADR 0031). Without it, a
   * grant that names a lease is refused: a private checkout never falls back to anonymous.
   */
  credentials?: CredentialSource;
}

/**
 * Executes one grant-authorized operation (ADR 0013): verify the grant, use it once, bind the
 * operation to the grant's (organization, employee, agent, thread) workspace, run it through
 * the provider, and store evidence as artifacts.
 */
export class ExecutionService {
  private readonly busy = new Set<string>();
  private readonly root: string;

  constructor(private readonly options: ExecutionServiceOptions) {
    this.root = resolve(options.workspaceRoot);
  }

  async execute(
    body: unknown,
    signal: AbortSignal,
    nowMs = Date.now(),
  ): Promise<ExecuteOperationResponse> {
    let request;
    try {
      request = parseExecuteOperationRequest(body);
    } catch (error) {
      throw new ExecutionRefused(400, (error as Error).message);
    }
    const { grant, operation } = request;
    try {
      this.options.verifier.verify(grant, operation, nowMs);
    } catch (error) {
      if (error instanceof GrantRejected) throw new ExecutionRefused(403, error.code);
      throw error;
    }
    if (
      grant.payload.isolation === 'sandboxed' &&
      this.options.provider.isolation !== 'sandboxed' &&
      !this.options.allowUnsandboxed
    )
      throw new ExecutionRefused(403, 'ISOLATION_UNAVAILABLE');

    const scope = grant.payload.correlation;
    const lockKey = `${scope.organizationId}/${scope.employeeId}/${scope.agentId}/${scope.threadId}`;
    // One operation at a time per workspace; checked before the grant is consumed.
    if (this.busy.has(lockKey)) throw new ExecutionRefused(409, 'WORKSPACE_BUSY');
    const claim = this.options.state.claimGrant(grant.payload.grantId);
    if (claim.kind === 'done') return claim.response;
    if (claim.kind === 'running') throw new ExecutionRefused(409, 'GRANT_IN_USE');
    this.busy.add(lockKey);
    const started = Date.now();
    try {
      const response = await this.run(grant, operation, signal, started);
      this.options.state.completeGrant(grant.payload.grantId, response);
      return response;
    } finally {
      this.busy.delete(lockKey);
    }
  }

  /**
   * After a crash: discard the partial checkout of every credentialed operation that never
   * finished, end its lease, and close its grant so it cannot be replayed. Call once at
   * startup, before serving requests.
   */
  async recover(): Promise<number> {
    const interrupted = this.options.state.pendingCredentials();
    for (const pending of interrupted) {
      rmSync(pending.target, { recursive: true, force: true, maxRetries: 3 });
      // The control plane expires the lease on its own if this cannot reach it.
      await this.options.credentials
        ?.release(pending.leaseId, pending.grantId, 'INTERRUPTED')
        .catch(() => {});
      this.options.state.completeGrant(pending.grantId, {
        result: {
          requestId: pending.requestId,
          status: 'FAILED',
          artifactIds: [],
          durationMs: 0,
          error: {
            code: 'OPERATION_INTERRUPTED',
            message: 'The execution runtime stopped during this checkout; it was discarded.',
          },
        },
        workspace: { id: pending.workspaceId, state: 'READY' },
        output: '',
        truncated: false,
        artifacts: [],
      });
      this.options.state.clearPendingCredential(pending.grantId);
    }
    return interrupted.length;
  }

  private async run(
    signed: Parameters<GrantVerifier['verify']>[0],
    operation: Parameters<ExecutionProvider['execute']>[1],
    signal: AbortSignal,
    started: number,
  ): Promise<ExecuteOperationResponse> {
    const grant = signed.payload;
    const scope = grant.correlation;
    let workspace = this.options.state.workspace(scope);
    const directory = (id: string) => join(this.root, 'workspaces', id);
    const refuse = (id: string, state: 'LOST' | 'READY', code: string, message: string) => ({
      result: {
        requestId: grant.requestId,
        status: 'FAILED' as const,
        artifactIds: [],
        durationMs: Date.now() - started,
        error: { code, message },
      },
      workspace: { id, state },
      output: '',
      truncated: false,
      artifacts: [],
    });
    if (workspace && (workspace.state === 'LOST' || !existsSync(directory(workspace.id)))) {
      // Never silently recreate a workspace that may have held work (ADR 0007).
      this.options.state.setWorkspaceState(workspace.id, 'LOST');
      return refuse(
        workspace.id,
        'LOST',
        'WORKSPACE_LOST',
        'The workspace for this thread was lost.',
      );
    }
    if (!workspace) {
      workspace = this.options.state.createWorkspace(scope);
      mkdirSync(directory(workspace.id), { recursive: true, mode: 0o700 });
    }
    const scratch = join(this.root, 'scratch', workspace.id);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    // A grant that names a credential lease is an authenticated checkout and nothing else.
    const binding = grant.credential;
    if (binding && (operation.kind !== 'git.checkout' || !this.options.credentials))
      return refuse(
        workspace.id,
        'READY',
        binding && operation.kind === 'git.checkout'
          ? 'CREDENTIALS_UNAVAILABLE'
          : 'CREDENTIAL_OPERATION_FORBIDDEN',
        'This execution runtime cannot perform an authenticated checkout.',
      );
    this.options.state.setWorkspaceState(workspace.id, 'IN_USE');
    let credential: CheckoutCredential | undefined;
    let leaseOutcome: CredentialReleaseOutcome = 'FAILED';
    try {
      if (binding && operation.kind === 'git.checkout') {
        // Recorded first, so a crash after this point is cleaned up at the next start.
        this.options.state.recordPendingCredential({
          grantId: grant.grantId,
          leaseId: binding.leaseId,
          requestId: grant.requestId,
          workspaceId: workspace.id,
          target: await inside(directory(workspace.id), operation.path, false),
        });
        try {
          credential = await this.options.credentials!.redeem(signed, binding.leaseId, signal);
        } catch (error) {
          if (!(error instanceof CredentialRefused)) throw error;
          return refuse(
            workspace.id,
            'READY',
            'CREDENTIAL_REFUSED',
            `The control plane refused the repository credential (${error.code}).`,
          );
        }
      }
      const outcome = await this.options.provider.execute(
        { id: workspace.id, root: directory(workspace.id), scratch },
        operation,
        grant.limits,
        signal,
        credential ? { credential } : {},
      );
      leaseOutcome = signal.aborted
        ? 'CANCELLED'
        : outcome.status === 'SUCCEEDED'
          ? 'SUCCEEDED'
          : outcome.status === 'TIMED_OUT'
            ? 'TIMED_OUT'
            : 'FAILED';
      const artifacts: ArtifactRegistration[] = [];
      for (const produced of outcome.artifacts) {
        const id = randomUUID();
        const stored = await this.options.artifacts.put({
          organizationId: scope.organizationId,
          runId: scope.runId,
          artifactId: id,
          name: produced.name,
          content: produced.content,
        });
        artifacts.push({
          id,
          type: produced.type,
          mediaType: produced.mediaType,
          name: produced.name,
          storageReference: stored.storageReference,
          checksum: { algorithm: 'sha256', value: stored.checksum },
          sizeBytes: stored.sizeBytes,
          retentionPolicy: 'STANDARD_30D',
        });
      }
      return {
        result: {
          requestId: grant.requestId,
          status: outcome.status,
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          artifactIds: artifacts.map((artifact) => artifact.id),
          durationMs: Date.now() - started,
          ...(outcome.error ? { error: outcome.error } : {}),
        },
        workspace: { id: workspace.id, state: 'READY' },
        output: outcome.output,
        truncated: outcome.truncated,
        artifacts,
      };
    } finally {
      if (binding) {
        credential = undefined;
        if (signal.aborted) leaseOutcome = 'CANCELLED';
        // Ends the lease whatever happened; the control plane expires it if this fails.
        await this.options.credentials
          ?.release(binding.leaseId, grant.grantId, leaseOutcome)
          .catch(() => {});
        this.options.state.clearPendingCredential(grant.grantId);
      }
      this.options.state.setWorkspaceState(workspace.id, 'READY');
    }
  }
}
