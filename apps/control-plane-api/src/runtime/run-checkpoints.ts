import { createHash } from 'node:crypto';
import type {
  RunCheckpointBinding,
  RuntimeCheckpointRecord,
  RuntimeCheckpointSaveRequest,
} from '@agents-foundry/contracts';
import { constraintKind, type PgStore, type Row } from '../db/pg-store.js';
import { ExecutionError } from '../execution/execution-service.js';

export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Checkpoint rows (ADR 0032). Callers have already authorized the runtime and its lease and
 * run inside the run's tenant scope, except `exists`, which claiming uses in platform scope.
 */
export class RunCheckpoints {
  constructor(private readonly db: PgStore) {}

  async exists(runId: string): Promise<boolean> {
    return Boolean(
      await this.db.get(
        'SELECT 1 AS found FROM agent_run_checkpoints WHERE run_id=? LIMIT 1',
        runId,
      ),
    );
  }

  private latest(organizationId: string, runId: string): Promise<Row | undefined> {
    return this.db.get(
      `SELECT * FROM agent_run_checkpoints WHERE run_id=? AND organization_id=?
       ORDER BY version DESC LIMIT 1`,
      runId,
      organizationId,
    );
  }

  /**
   * Stores the next version and keeps only it and the one before. A version that is not
   * exactly the next one is refused: another runtime advanced the run.
   */
  async append(
    organizationId: string,
    threadId: string,
    runtimeId: string,
    request: RuntimeCheckpointSaveRequest,
    nowIso: string,
  ): Promise<void> {
    const runId = request.correlation.runId;
    const current = Number((await this.latest(organizationId, runId))?.['version'] ?? 0);
    if (request.version !== current + 1)
      throw new ExecutionError(409, 'CHECKPOINT_VERSION_CONFLICT');
    const { binding } = request;
    try {
      await this.db.run(
        `INSERT INTO agent_run_checkpoints (organization_id,run_id,version,thread_id,session_id,runtime_id,
         manifest_id,manifest_digest,workflow,step_id,approval_id,kernel_id,runtime_sequence,body_sha256,
         body_bytes,body,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        organizationId,
        runId,
        request.version,
        threadId,
        request.sessionId,
        runtimeId,
        binding.manifestId,
        binding.manifestDigest,
        binding.workflow,
        binding.stepId,
        binding.approvalId,
        binding.kernelId,
        binding.runtimeSequence,
        request.sha256,
        Buffer.byteLength(request.body, 'utf8'),
        request.body,
        nowIso,
      );
    } catch (error) {
      if (
        constraintKind(error) === 'unique' ||
        (error instanceof Error && error.message.includes('CHECKPOINT_VERSION_CONFLICT'))
      )
        throw new ExecutionError(409, 'CHECKPOINT_VERSION_CONFLICT');
      throw error;
    }
    await this.db.run(
      'DELETE FROM agent_run_checkpoints WHERE run_id=? AND organization_id=? AND version<?',
      runId,
      organizationId,
      request.version - 1,
    );
  }

  /** The latest checkpoint, or null. A body that no longer matches its digest fails closed. */
  async read(organizationId: string, runId: string): Promise<RuntimeCheckpointRecord | null> {
    const row = await this.latest(organizationId, runId);
    if (!row) return null;
    const body = String(row['body']);
    if (
      sha256Text(body) !== row['body_sha256'] ||
      Buffer.byteLength(body, 'utf8') !== Number(row['body_bytes'])
    )
      throw new ExecutionError(409, 'CHECKPOINT_CORRUPT');
    const optional = (key: string) => (row[key] === null ? null : String(row[key]));
    const binding: RunCheckpointBinding = {
      manifestId: String(row['manifest_id']),
      manifestDigest: String(row['manifest_digest']),
      workflow: optional('workflow'),
      stepId: optional('step_id'),
      approvalId: optional('approval_id'),
      kernelId: String(row['kernel_id']),
      runtimeSequence: Number(row['runtime_sequence']),
    };
    return {
      runId,
      version: Number(row['version']),
      binding,
      sha256: String(row['body_sha256']),
      body,
    };
  }

  /** Checkpoints hold conversation content; they go when the run ends. */
  async deleteForRun(organizationId: string, runId: string): Promise<void> {
    await this.db.run(
      'DELETE FROM agent_run_checkpoints WHERE run_id=? AND organization_id=?',
      runId,
      organizationId,
    );
  }
}
