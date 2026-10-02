import { createHash } from 'node:crypto';
import type {
  Actor,
  ArtifactRegistration,
  ArtifactRetentionPolicy,
  ArtifactRetrieval,
  ArtifactUpload,
  ArtifactUploadDescriptor,
  RuntimeCorrelation,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import {
  parseExecutionArtifactUploadRequest,
  parseSignedExecutionGrant,
} from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import { parseRuntimeArtifactUploadRequest } from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import type { Audit } from '../actions/action-policy-service.js';
import { constraintKind, type PgStore, type Row } from '../db/pg-store.js';
import { ExecutionError } from '../execution/execution-service.js';
import { servesOrganization, type RuntimeIdentity } from '../runtime/runtime-identity.js';
import { ArtifactStoreError, type ArtifactStore } from './artifact-store.js';

const DAY_MS = 24 * 60 * 60_000;
/** How long each retention class keeps an artifact's bytes. A legal hold keeps them. */
export const RETENTION_MS: Record<ArtifactRetentionPolicy, number | null> = {
  EPHEMERAL: DAY_MS,
  STANDARD_30D: 30 * DAY_MS,
  EXTENDED_365D: 365 * DAY_MS,
  LEGAL_HOLD: null,
};
/** Bytes that were uploaded but never registered by their run are removed after this. */
export const UNREGISTERED_ARTIFACT_MS = DAY_MS;
/** A download permission lasts this long. */
export const ARTIFACT_RETRIEVAL_TTL_MS = 60_000;
/** Limits on what one run may store. */
export const MAX_RUN_ARTIFACTS = 200;
export const MAX_RUN_ARTIFACT_BYTES = 512 * 1024 * 1024;

const RETRIEVAL_PATH = '/api/execution/v1/artifact-content/';
const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const keySegment = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

export interface ArtifactServiceDependencies {
  audit: Audit;
  verifyGrant: (grant: SignedExecutionGrant) => boolean;
  /** Signs and verifies retrieval permissions (domain-separated from every other signature). */
  signRetrieval: (payload: string) => string;
  verifyRetrieval: (payload: string, signature: string) => boolean;
  /** The artifact's run, if `actor` may read it; throws ARTIFACT_NOT_FOUND otherwise. */
  readableArtifact: (
    actor: Actor,
    artifactId: string,
  ) => Promise<{ id: string; runId: string; name: string; mediaType: string }>;
  /** Lease, correlation, run and step checks for an agent runtime's upload. */
  authorizeAgentUpload: (
    runtime: RuntimeIdentity,
    correlation: RuntimeCorrelation & { stepId: string },
  ) => Promise<{ organizationId: string; threadId: string }>;
  /** Refuse registrations of artifacts whose bytes this control plane does not hold. */
  requireManaged?: boolean;
  now?: () => number;
}

interface Scope {
  organizationId: string;
  threadId: string;
  runId: string;
  stepId: string;
  toolCallId: string | null;
}

/**
 * Durable artifact storage (ADR 0033). Bytes go to the artifact store; PostgreSQL keeps the
 * metadata and lifecycle. Runtimes upload through the signed transport and never hold the
 * store's credentials. People retrieve through a short-lived, signed permission that works
 * only for them, after the same authorization as the artifact's metadata. Hashes are checked
 * when bytes are stored, when the artifact is registered and when it is retrieved.
 */
export class ArtifactService {
  private readonly now: () => number;

  constructor(
    private readonly db: PgStore,
    readonly store: ArtifactStore,
    private readonly deps: ArtifactServiceDependencies,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** `POST /runtime/v1/artifacts`: an agent runtime stores bytes for a step of a run it holds. */
  async uploadFromAgent(runtime: RuntimeIdentity, body: unknown): Promise<ArtifactUpload> {
    const request = parseRuntimeArtifactUploadRequest(body);
    const { correlation } = request;
    const { organizationId, threadId } = await this.deps.authorizeAgentUpload(runtime, correlation);
    return this.keep(
      {
        organizationId,
        threadId,
        runId: correlation.runId,
        stepId: correlation.stepId,
        toolCallId: correlation.toolCallId ?? null,
      },
      request.artifact,
      request.content,
      runtime.id,
    );
  }

  /**
   * `POST /runtime/v1/artifacts/execution`: an execution runtime stores evidence of a granted
   * operation. The tenant, run and step come from the grant the control plane signed, never
   * from the request.
   */
  async uploadFromExecution(runtime: RuntimeIdentity, body: unknown): Promise<ArtifactUpload> {
    if (runtime.role !== 'execution') throw new ExecutionError(403, 'RUNTIME_ROLE_FORBIDDEN');
    const request = parseExecutionArtifactUploadRequest(body);
    let grant: SignedExecutionGrant;
    try {
      grant = parseSignedExecutionGrant(request.grant);
    } catch {
      throw new ExecutionError(403, 'ARTIFACT_GRANT_INVALID');
    }
    if (!this.deps.verifyGrant(grant)) throw new ExecutionError(403, 'ARTIFACT_GRANT_INVALID');
    const { correlation } = grant.payload;
    const organizationId = correlation.organizationId;
    if (!servesOrganization(runtime, organizationId))
      throw new ExecutionError(403, 'ARTIFACT_ORGANIZATION_FORBIDDEN');
    // Evidence is uploaded when the operation ends, which may be after the grant expired, so
    // the grant must be one this control plane recorded for a run that is still running.
    const run = await this.db.tenant(organizationId, () =>
      this.db.get<{ thread_id: string; status: string }>(
        `SELECT r.thread_id, r.status FROM agent_execution_grants g
         JOIN agent_runs r ON r.id=g.run_id AND r.organization_id=g.organization_id
         WHERE g.grant_id=? AND g.organization_id=? AND g.run_id=?`,
        grant.payload.grantId,
        organizationId,
        correlation.runId,
      ),
    );
    if (!run) throw new ExecutionError(403, 'ARTIFACT_GRANT_INVALID');
    if (run.status !== 'RUNNING') throw new ExecutionError(409, 'RUN_NOT_RUNNING');
    return this.keep(
      {
        organizationId,
        threadId: run.thread_id,
        runId: correlation.runId,
        stepId: correlation.stepId,
        toolCallId: correlation.toolCallId,
      },
      request.artifact,
      request.content,
      runtime.id,
    );
  }

  /** Verifies the bytes against what was declared, records the object and stores it. */
  private async keep(
    scope: Scope,
    artifact: ArtifactUploadDescriptor,
    encoded: string,
    uploadedBy: string,
  ): Promise<ArtifactUpload> {
    const content = Buffer.from(encoded, 'base64');
    if (content.byteLength !== artifact.sizeBytes)
      throw new ExecutionError(400, 'ARTIFACT_SIZE_MISMATCH');
    if (sha256(content) !== artifact.checksum.value)
      throw new ExecutionError(400, 'ARTIFACT_DIGEST_MISMATCH');
    if (!keySegment.test(scope.organizationId))
      throw new ExecutionError(409, 'ARTIFACT_KEY_INVALID');
    // The key is the control plane's own, and always inside the tenant's prefix.
    const key = `${scope.organizationId}/${scope.runId}/${artifact.id}`;
    const nowMs = this.now();
    const retention = RETENTION_MS[artifact.retentionPolicy];
    const result: ArtifactUpload = {
      artifactId: artifact.id,
      storageReference: `artifact://${this.store.name}/${key}`,
      checksum: artifact.checksum,
      sizeBytes: artifact.sizeBytes,
    };
    let stored: boolean;
    try {
      stored = await this.db.tenant(scope.organizationId, async () => {
        const existing = await this.db.get(
          'SELECT * FROM agent_artifact_objects WHERE artifact_id=? AND organization_id=?',
          artifact.id,
          scope.organizationId,
        );
        if (existing) {
          // A retried upload of the same bytes for the same step is answered from the record.
          if (
            existing['run_id'] !== scope.runId ||
            existing['step_id'] !== scope.stepId ||
            existing['sha256'] !== artifact.checksum.value ||
            Number(existing['size_bytes']) !== artifact.sizeBytes ||
            !['PENDING', 'STORED'].includes(String(existing['state']))
          )
            throw new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS');
          return existing['state'] === 'STORED';
        }
        const usage = (await this.db.get<{ count: number; bytes: string }>(
          `SELECT count(*)::int AS count, COALESCE(sum(size_bytes),0)::text AS bytes
           FROM agent_artifact_objects WHERE run_id=? AND organization_id=? AND state<>'DELETED'`,
          scope.runId,
          scope.organizationId,
        ))!;
        if (
          usage.count >= MAX_RUN_ARTIFACTS ||
          Number(usage.bytes) + artifact.sizeBytes > MAX_RUN_ARTIFACT_BYTES
        )
          throw new ExecutionError(409, 'ARTIFACT_QUOTA_EXCEEDED');
        await this.db.run(
          `INSERT INTO agent_artifact_objects (artifact_id,organization_id,thread_id,run_id,step_id,tool_call_id,
           store,storage_key,media_type,size_bytes,sha256,retention_class,state,uploaded_by,created_at,expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?)`,
          artifact.id,
          scope.organizationId,
          scope.threadId,
          scope.runId,
          scope.stepId,
          scope.toolCallId,
          this.store.name,
          key,
          artifact.mediaType,
          artifact.sizeBytes,
          artifact.checksum.value,
          artifact.retentionPolicy,
          uploadedBy,
          new Date(nowMs).toISOString(),
          retention === null ? null : new Date(nowMs + retention).toISOString(),
        );
        return false;
      });
    } catch (error) {
      // The identifier is taken by another organization's artifact, or the step is not the run's.
      if (constraintKind(error) === 'unique')
        throw new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS');
      if (error instanceof Error && error.message.includes('ARTIFACT_SCOPE_MISMATCH'))
        throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
      throw error;
    }
    if (stored) return result;
    try {
      await this.store.put(key, content, artifact.mediaType);
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === 'ARTIFACT_KEY_INVALID')
        throw new ExecutionError(409, 'ARTIFACT_KEY_INVALID');
      // The row stays PENDING; retention removes it if the upload is never retried.
      throw new ExecutionError(503, 'ARTIFACT_STORE_UNAVAILABLE');
    }
    await this.db.tenant(scope.organizationId, async () => {
      await this.db.run(
        `UPDATE agent_artifact_objects SET state='STORED' WHERE artifact_id=? AND organization_id=? AND state='PENDING'`,
        artifact.id,
        scope.organizationId,
      );
      await this.deps.audit(
        uploadedBy,
        'artifact.stored',
        'agent_run',
        scope.runId,
        {
          artifactId: artifact.id,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.checksum.value,
          retention: artifact.retentionPolicy,
        },
        scope.organizationId,
      );
    });
    return result;
  }

  /**
   * Called in the transaction that records `artifact.created`. A reference to this control
   * plane's store must name bytes it holds for that run, with the same hash, size, media
   * type and retention. References to a runtime's own store are unmanaged content.
   */
  async registered(
    organizationId: string,
    runId: string,
    artifact: ArtifactRegistration,
  ): Promise<void> {
    const reference = /^artifact:\/\/([a-z0-9][a-z0-9-]{0,62})\/(.+)$/.exec(
      artifact.storageReference,
    );
    if (!reference || reference[1] !== this.store.name) {
      if (this.deps.requireManaged) throw new ExecutionError(409, 'ARTIFACT_STORE_UNMANAGED');
      return;
    }
    const object = await this.db.get(
      'SELECT * FROM agent_artifact_objects WHERE artifact_id=? AND organization_id=? FOR UPDATE',
      artifact.id,
      organizationId,
    );
    if (
      !object ||
      object['state'] !== 'STORED' ||
      object['run_id'] !== runId ||
      object['storage_key'] !== reference[2] ||
      object['sha256'] !== artifact.checksum.value ||
      Number(object['size_bytes']) !== artifact.sizeBytes ||
      object['media_type'] !== artifact.mediaType ||
      object['retention_class'] !== artifact.retentionPolicy
    )
      throw new ExecutionError(409, 'ARTIFACT_OBJECT_MISMATCH');
    await this.db.run(
      `UPDATE agent_artifact_objects SET state='REGISTERED', registered_at=?
       WHERE artifact_id=? AND organization_id=?`,
      new Date(this.now()).toISOString(),
      artifact.id,
      organizationId,
    );
  }

  /** A permission for `actor` to download the artifact during the next minute. */
  async requestRetrieval(actor: Actor, artifactId: string): Promise<ArtifactRetrieval> {
    const artifact = await this.deps.readableArtifact(actor, artifactId);
    const object = await this.object(actor.organizationId, artifact.id);
    if (!object) throw new ExecutionError(409, 'ARTIFACT_CONTENT_UNMANAGED');
    if (object['state'] === 'DELETED') throw new ExecutionError(410, 'ARTIFACT_CONTENT_DELETED');
    if (object['state'] !== 'REGISTERED') throw new ExecutionError(404, 'ARTIFACT_NOT_FOUND');
    const expiresAt = this.now() + ARTIFACT_RETRIEVAL_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify({
        a: artifact.id,
        o: actor.organizationId,
        u: actor.id,
        s: String(object['sha256']),
        e: expiresAt,
      }),
      'utf8',
    ).toString('base64url');
    await this.deps.audit(
      actor.id,
      'artifact.retrieval.granted',
      'agent_run',
      artifact.runId,
      { artifactId: artifact.id },
      actor.organizationId,
    );
    return {
      artifactId: artifact.id,
      path: `${RETRIEVAL_PATH}${payload}.${this.deps.signRetrieval(payload)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * The artifact's bytes for a valid permission presented by the person it was issued to.
   * Authorization is repeated, and the bytes are returned only if they still match the hash
   * recorded when they were stored.
   */
  async retrieve(
    actor: Actor,
    token: string,
  ): Promise<{ content: Buffer; mediaType: string; name: string }> {
    const invalid = new ExecutionError(403, 'ARTIFACT_RETRIEVAL_INVALID');
    const [payload, signature, ...rest] = token.split('.');
    if (!payload || !signature || rest.length || !this.deps.verifyRetrieval(payload, signature))
      throw invalid;
    let claim: { a?: unknown; o?: unknown; u?: unknown; s?: unknown; e?: unknown };
    try {
      claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claim;
    } catch {
      throw invalid;
    }
    if (
      typeof claim.a !== 'string' ||
      typeof claim.e !== 'number' ||
      claim.o !== actor.organizationId ||
      claim.u !== actor.id
    )
      throw invalid;
    if (!(this.now() < claim.e)) throw new ExecutionError(403, 'ARTIFACT_RETRIEVAL_EXPIRED');
    const artifact = await this.deps.readableArtifact(actor, claim.a);
    const object = await this.object(actor.organizationId, artifact.id);
    if (!object) throw new ExecutionError(404, 'ARTIFACT_NOT_FOUND');
    if (object['state'] === 'DELETED') throw new ExecutionError(410, 'ARTIFACT_CONTENT_DELETED');
    if (object['state'] !== 'REGISTERED' || object['sha256'] !== claim.s) throw invalid;
    const key = String(object['storage_key']);
    const failed = async (code: string) => {
      await this.deps.audit(
        actor.id,
        'artifact.integrity_failed',
        'agent_run',
        artifact.runId,
        { artifactId: artifact.id, code },
        actor.organizationId,
      );
      return new ExecutionError(409, 'ARTIFACT_INTEGRITY_FAILED');
    };
    // A row can only ever point inside its own tenant's prefix of this store.
    if (object['store'] !== this.store.name || !key.startsWith(`${actor.organizationId}/`))
      throw await failed('KEY_OUTSIDE_TENANT');
    let content: Buffer | null;
    try {
      content = await this.store.get(key);
    } catch {
      throw new ExecutionError(503, 'ARTIFACT_STORE_UNAVAILABLE');
    }
    if (!content) throw await failed('CONTENT_MISSING');
    if (content.byteLength !== Number(object['size_bytes']) || sha256(content) !== object['sha256'])
      throw await failed('DIGEST_MISMATCH');
    await this.deps.audit(
      actor.id,
      'artifact.retrieved',
      'agent_run',
      artifact.runId,
      { artifactId: artifact.id, sizeBytes: content.byteLength },
      actor.organizationId,
    );
    return { content, mediaType: artifact.mediaType, name: artifact.name };
  }

  /**
   * Removes the bytes of artifacts whose retention ended and of uploads no run registered,
   * and records the deletion. Bytes are removed first, so a row is never marked deleted while
   * its bytes remain; a store failure leaves it for the next pass.
   */
  async enforceRetention(nowMs = this.now()): Promise<number> {
    const due = await this.db.platform(() =>
      this.db.all<{ artifact_id: string; organization_id: string; state: string }>(
        `SELECT artifact_id, organization_id, state FROM agent_artifact_objects
         WHERE (state='REGISTERED' AND expires_at <= ?)
            OR (state IN ('PENDING','STORED') AND created_at < ?)
         ORDER BY seq LIMIT 200`,
        new Date(nowMs).toISOString(),
        new Date(nowMs - UNREGISTERED_ARTIFACT_MS).toISOString(),
      ),
    );
    let removed = 0;
    for (const item of due) {
      const reason = item.state === 'REGISTERED' ? 'RETENTION_EXPIRED' : 'NEVER_REGISTERED';
      if (await this.remove(item.organization_id, item.artifact_id, reason, nowMs)) removed += 1;
    }
    return removed;
  }

  private async remove(
    organizationId: string,
    artifactId: string,
    reason: string,
    nowMs: number,
  ): Promise<boolean> {
    const object = await this.object(organizationId, artifactId);
    if (!object || object['state'] === 'DELETED') return false;
    try {
      await this.store.delete(String(object['storage_key']));
    } catch {
      return false;
    }
    return this.db.tenant(organizationId, async () => {
      const changed = await this.db.run(
        `UPDATE agent_artifact_objects SET state='DELETED', deleted_at=?, deletion_reason=?
         WHERE artifact_id=? AND organization_id=? AND state<>'DELETED'`,
        new Date(nowMs).toISOString(),
        reason,
        artifactId,
        organizationId,
      );
      if (changed.changes !== 1) return false;
      await this.deps.audit(
        'control-plane',
        'artifact.deleted',
        'agent_run',
        String(object['run_id']),
        { artifactId, reason, sizeBytes: Number(object['size_bytes']) },
        organizationId,
      );
      return true;
    });
  }

  private object(organizationId: string, artifactId: string): Promise<Row | undefined> {
    return this.db.tenant(organizationId, () =>
      this.db.get(
        'SELECT * FROM agent_artifact_objects WHERE artifact_id=? AND organization_id=?',
        artifactId,
        organizationId,
      ),
    );
  }
}
