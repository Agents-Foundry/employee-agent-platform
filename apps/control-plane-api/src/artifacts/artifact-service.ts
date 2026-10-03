import { createHash } from 'node:crypto';
import type {
  Actor,
  ArtifactRegistration,
  ArtifactRetentionPolicy,
  ArtifactRetrieval,
  ArtifactUpload,
  ArtifactUploadAuthorization,
  ArtifactUploadDescriptor,
  RuntimeCorrelation,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import {
  parseExecutionArtifactAuthorizeRequest,
  parseExecutionArtifactCompleteRequest,
  parseExecutionArtifactUploadRequest,
  parseSignedExecutionGrant,
} from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import { parseRuntimeArtifactUploadRequest } from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import { runtimeTransportPaths } from '../../../../packages/contracts/src/runtime/v1/transport.js';
import type { Telemetry } from '../../../../packages/telemetry/src/index.js';
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
/** A permission to upload through the control plane's own path lasts this long. */
export const ARTIFACT_UPLOAD_TTL_MS = 5 * 60_000;
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
  /** Signs and verifies upload permissions for the control plane's own upload path. */
  signUpload: (payload: string) => string;
  verifyUpload: (payload: string, signature: string) => boolean;
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
  telemetry: Telemetry;
  now?: () => number;
}

interface Scope {
  organizationId: string;
  threadId: string;
  runId: string;
  stepId: string;
  toolCallId: string | null;
}

type Source = 'agent' | 'execution' | 'direct';

/**
 * Durable artifact storage (ADR 0033). Bytes go to the artifact store; PostgreSQL keeps the
 * metadata and lifecycle. Runtimes upload through the signed transport, or, for large browser
 * evidence, straight to the store with a permission for exactly those bytes (ADR 0037). They
 * never hold the store's credentials. People retrieve through a short-lived, signed permission
 * that works only for them, after the same authorization as the artifact's metadata. Hashes
 * are checked when bytes are stored, when the artifact is registered and when it is retrieved.
 */
export class ArtifactService {
  private readonly now: () => number;
  private readonly telemetry: Telemetry;

  constructor(
    private readonly db: PgStore,
    readonly store: ArtifactStore,
    private readonly deps: ArtifactServiceDependencies,
  ) {
    this.now = deps.now ?? Date.now;
    this.telemetry = deps.telemetry;
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
      Buffer.from(request.content, 'base64'),
      runtime.id,
      'agent',
    );
  }

  /**
   * `POST /runtime/v1/artifacts/execution`: an execution runtime stores evidence of a granted
   * operation. The tenant, run and step come from the grant the control plane signed, never
   * from the request.
   */
  async uploadFromExecution(runtime: RuntimeIdentity, body: unknown): Promise<ArtifactUpload> {
    const request = parseExecutionArtifactUploadRequest(body);
    const scope = await this.grantScope(runtime, request.grant);
    return this.keep(
      scope,
      request.artifact,
      Buffer.from(request.content, 'base64'),
      runtime.id,
      'execution',
    );
  }

  /**
   * `POST /runtime/v1/artifacts/execution/authorize`: permission for an execution runtime to
   * upload one artifact's bytes directly (ADR 0037). The object is reserved for the grant's
   * tenant, run, step and tool call first, under the same quotas as any other artifact; the
   * permission is then for that key, that size, that hash and that media type only.
   */
  async authorizeDirectUpload(
    runtime: RuntimeIdentity,
    body: unknown,
  ): Promise<ArtifactUploadAuthorization> {
    const request = parseExecutionArtifactAuthorizeRequest(body);
    const scope = await this.grantScope(runtime, request.grant);
    const { artifact } = request;
    const { key, state } = await this.reserve(scope, artifact, runtime.id, 'direct');
    if (state === 'STORED') throw new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS');
    const upload = {
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.checksum.value,
    };
    if (this.store.authorizePut) {
      try {
        return {
          artifactId: artifact.id,
          target: 'STORE',
          ...this.store.authorizePut(key, upload),
        };
      } catch {
        this.storeFailed('authorize');
        throw new ExecutionError(503, 'ARTIFACT_STORE_UNAVAILABLE');
      }
    }
    // The store cannot authorize uploads itself: the runtime sends the bytes here instead.
    const expiresAt = this.now() + ARTIFACT_UPLOAD_TTL_MS;
    const payload = Buffer.from(
      JSON.stringify({
        a: artifact.id,
        o: scope.organizationId,
        r: runtime.id,
        s: upload.sha256,
        n: upload.sizeBytes,
        e: expiresAt,
      }),
      'utf8',
    ).toString('base64url');
    return {
      artifactId: artifact.id,
      target: 'CONTROL_PLANE',
      url: `${runtimeTransportPaths.artifactContent}/${payload}.${this.deps.signUpload(payload)}`,
      headers: { 'content-type': artifact.mediaType },
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * `PUT /runtime/v1/artifact-content/:token`: the bytes for a permission this control plane
   * issued, from the runtime it was issued to. Anything but exactly the declared bytes is
   * refused before it reaches the store.
   */
  async receiveDirectContent(
    runtime: RuntimeIdentity,
    token: string,
    content: Buffer,
  ): Promise<void> {
    const invalid = new ExecutionError(403, 'ARTIFACT_UPLOAD_INVALID');
    const [payload, signature, ...rest] = token.split('.');
    if (!payload || !signature || rest.length || !this.deps.verifyUpload(payload, signature))
      throw invalid;
    let claim: { a?: unknown; o?: unknown; r?: unknown; s?: unknown; n?: unknown; e?: unknown };
    try {
      claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claim;
    } catch {
      throw invalid;
    }
    if (
      typeof claim.a !== 'string' ||
      typeof claim.o !== 'string' ||
      typeof claim.e !== 'number' ||
      claim.r !== runtime.id ||
      !servesOrganization(runtime, claim.o)
    )
      throw invalid;
    if (!(this.now() < claim.e)) throw new ExecutionError(403, 'ARTIFACT_UPLOAD_EXPIRED');
    const object = await this.object(claim.o, claim.a);
    if (
      !object ||
      object['state'] !== 'PENDING' ||
      object['uploaded_by'] !== runtime.id ||
      object['sha256'] !== claim.s ||
      Number(object['size_bytes']) !== claim.n
    )
      throw invalid;
    if (content.byteLength !== claim.n) throw new ExecutionError(400, 'ARTIFACT_SIZE_MISMATCH');
    if (sha256(content) !== claim.s) throw new ExecutionError(400, 'ARTIFACT_DIGEST_MISMATCH');
    await this.put(String(object['storage_key']), content, String(object['media_type']));
  }

  /**
   * `POST /runtime/v1/artifacts/execution/complete`: the runtime says the bytes are in the
   * store. The control plane reads them back and accepts the object only if they are exactly
   * what was declared; anything else is removed and recorded as an integrity failure.
   */
  async completeDirectUpload(runtime: RuntimeIdentity, body: unknown): Promise<ArtifactUpload> {
    const request = parseExecutionArtifactCompleteRequest(body);
    const scope = await this.grantScope(runtime, request.grant);
    const object = await this.object(scope.organizationId, request.artifactId);
    if (
      !object ||
      object['run_id'] !== scope.runId ||
      object['step_id'] !== scope.stepId ||
      object['uploaded_by'] !== runtime.id ||
      !['PENDING', 'STORED'].includes(String(object['state']))
    )
      throw new ExecutionError(404, 'ARTIFACT_NOT_FOUND');
    const key = String(object['storage_key']);
    const result: ArtifactUpload = {
      artifactId: request.artifactId,
      storageReference: `artifact://${this.store.name}/${key}`,
      checksum: { algorithm: 'sha256', value: String(object['sha256']) },
      sizeBytes: Number(object['size_bytes']),
    };
    if (object['state'] === 'STORED') return result;
    let content: Buffer | null;
    try {
      content = await this.store.get(key);
    } catch {
      this.storeFailed('get');
      throw new ExecutionError(503, 'ARTIFACT_STORE_UNAVAILABLE');
    }
    if (!content) {
      this.uploaded('direct', 'ARTIFACT_CONTENT_MISSING');
      throw new ExecutionError(409, 'ARTIFACT_CONTENT_MISSING');
    }
    if (content.byteLength !== result.sizeBytes || sha256(content) !== result.checksum.value) {
      // Not what was declared: it is never registered, and the bytes do not stay.
      await this.remove(scope.organizationId, request.artifactId, 'INTEGRITY_FAILED', this.now());
      await this.db.tenant(scope.organizationId, () =>
        this.deps.audit(
          runtime.id,
          'artifact.integrity_failed',
          'agent_run',
          scope.runId,
          { artifactId: request.artifactId, code: 'UPLOAD_DIGEST_MISMATCH' },
          scope.organizationId,
        ),
      );
      this.telemetry.count('af_artifact_integrity_failures_total', {
        code: 'UPLOAD_DIGEST_MISMATCH',
      });
      this.uploaded('direct', 'ARTIFACT_DIGEST_MISMATCH');
      throw new ExecutionError(409, 'ARTIFACT_DIGEST_MISMATCH');
    }
    await this.stored(
      scope,
      request.artifactId,
      result,
      String(object['retention_class']),
      runtime.id,
      'direct',
      String(object['media_type']),
      Number(Date.parse(String(object['created_at']))),
    );
    return result;
  }

  /**
   * The tenant, run and step an execution runtime may store evidence for: those of a grant
   * this control plane signed and recorded, for a run that is still running. Evidence is
   * uploaded when the operation ends, which may be after the grant itself expired.
   */
  private async grantScope(runtime: RuntimeIdentity, unverified: unknown): Promise<Scope> {
    if (runtime.role !== 'execution') throw new ExecutionError(403, 'RUNTIME_ROLE_FORBIDDEN');
    let grant: SignedExecutionGrant;
    try {
      grant = parseSignedExecutionGrant(unverified);
    } catch {
      throw new ExecutionError(403, 'ARTIFACT_GRANT_INVALID');
    }
    if (!this.deps.verifyGrant(grant)) throw new ExecutionError(403, 'ARTIFACT_GRANT_INVALID');
    const { correlation } = grant.payload;
    const organizationId = correlation.organizationId;
    if (!servesOrganization(runtime, organizationId))
      throw new ExecutionError(403, 'ARTIFACT_ORGANIZATION_FORBIDDEN');
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
    return {
      organizationId,
      threadId: run.thread_id,
      runId: correlation.runId,
      stepId: correlation.stepId,
      toolCallId: correlation.toolCallId,
    };
  }

  private uploaded(source: Source, result: string): void {
    this.telemetry.count('af_artifact_uploads_total', { source, result });
  }

  private storeFailed(operation: string): void {
    this.telemetry.count('af_object_store_failures_total', { operation });
  }

  /**
   * Records the object the bytes will become, as PENDING, under the run's quotas. A repeated
   * request for the same bytes and step is answered from the record. The key is the control
   * plane's own, and always inside the tenant's prefix.
   */
  private async reserve(
    scope: Scope,
    artifact: ArtifactUploadDescriptor,
    uploadedBy: string,
    source: Source,
  ): Promise<{ key: string; state: 'PENDING' | 'STORED' }> {
    if (!keySegment.test(scope.organizationId)) {
      this.uploaded(source, 'ARTIFACT_KEY_INVALID');
      throw new ExecutionError(409, 'ARTIFACT_KEY_INVALID');
    }
    const key = `${scope.organizationId}/${scope.runId}/${artifact.id}`;
    const nowMs = this.now();
    const retention = RETENTION_MS[artifact.retentionPolicy];
    try {
      const state = await this.db.tenant(scope.organizationId, async () => {
        const existing = await this.db.get(
          'SELECT * FROM agent_artifact_objects WHERE artifact_id=? AND organization_id=?',
          artifact.id,
          scope.organizationId,
        );
        if (existing) {
          if (
            existing['run_id'] !== scope.runId ||
            existing['step_id'] !== scope.stepId ||
            existing['sha256'] !== artifact.checksum.value ||
            Number(existing['size_bytes']) !== artifact.sizeBytes ||
            existing['media_type'] !== artifact.mediaType ||
            !['PENDING', 'STORED'].includes(String(existing['state']))
          )
            throw new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS');
          return String(existing['state']) as 'PENDING' | 'STORED';
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
        return 'PENDING' as const;
      });
      return { key, state };
    } catch (error) {
      // The identifier is taken by another organization's artifact, or the step is not the run's.
      const refusal =
        constraintKind(error) === 'unique'
          ? new ExecutionError(409, 'ARTIFACT_ALREADY_EXISTS')
          : error instanceof Error && error.message.includes('ARTIFACT_SCOPE_MISMATCH')
            ? new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH')
            : error;
      if (refusal instanceof ExecutionError) this.uploaded(source, refusal.message);
      throw refusal;
    }
  }

  private async put(key: string, content: Buffer, mediaType: string): Promise<void> {
    try {
      await this.store.put(key, content, mediaType);
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === 'ARTIFACT_KEY_INVALID')
        throw new ExecutionError(409, 'ARTIFACT_KEY_INVALID');
      this.storeFailed('put');
      // The row stays PENDING; retention removes it if the upload is never retried.
      throw new ExecutionError(503, 'ARTIFACT_STORE_UNAVAILABLE');
    }
  }

  /** Marks a reserved object as stored and records it. */
  private async stored(
    scope: Scope,
    artifactId: string,
    result: ArtifactUpload,
    retention: string,
    uploadedBy: string,
    source: Source,
    mediaType: string,
    startedMs: number,
  ): Promise<void> {
    await this.db.tenant(scope.organizationId, async () => {
      await this.db.run(
        `UPDATE agent_artifact_objects SET state='STORED' WHERE artifact_id=? AND organization_id=? AND state='PENDING'`,
        artifactId,
        scope.organizationId,
      );
      await this.deps.audit(
        uploadedBy,
        'artifact.stored',
        'agent_run',
        scope.runId,
        {
          artifactId,
          sizeBytes: result.sizeBytes,
          sha256: result.checksum.value,
          retention,
          ...(source === 'direct' ? { direct: true } : {}),
        },
        scope.organizationId,
      );
      this.db.afterCommit(() => {
        this.uploaded(source, 'stored');
        this.telemetry.count('af_artifact_upload_bytes_total', { source }, result.sizeBytes);
        this.telemetry.span({
          runId: scope.runId,
          name: 'artifact.upload',
          subject: 'artifact',
          id: artifactId,
          parent: scope.toolCallId
            ? { subject: 'tool', id: scope.toolCallId }
            : { subject: 'step', id: scope.stepId },
          startTimeMs: startedMs,
          attributes: {
            'af.organization.id': scope.organizationId,
            'af.thread.id': scope.threadId,
            'af.step.id': scope.stepId,
            'af.artifact.id': artifactId,
            'af.artifact.media_type': mediaType,
            'af.artifact.size_bytes': result.sizeBytes,
            'af.artifact.retention': retention,
            'af.artifact.source': source,
            'af.store': this.store.name,
          },
        });
      });
    });
  }

  /** Verifies the bytes against what was declared, records the object and stores it. */
  private async keep(
    scope: Scope,
    artifact: ArtifactUploadDescriptor,
    content: Buffer,
    uploadedBy: string,
    source: Source,
  ): Promise<ArtifactUpload> {
    const started = this.now();
    if (content.byteLength !== artifact.sizeBytes) {
      this.uploaded(source, 'ARTIFACT_SIZE_MISMATCH');
      throw new ExecutionError(400, 'ARTIFACT_SIZE_MISMATCH');
    }
    if (sha256(content) !== artifact.checksum.value) {
      this.uploaded(source, 'ARTIFACT_DIGEST_MISMATCH');
      throw new ExecutionError(400, 'ARTIFACT_DIGEST_MISMATCH');
    }
    const { key, state } = await this.reserve(scope, artifact, uploadedBy, source);
    const result: ArtifactUpload = {
      artifactId: artifact.id,
      storageReference: `artifact://${this.store.name}/${key}`,
      checksum: artifact.checksum,
      sizeBytes: artifact.sizeBytes,
    };
    // A retried upload of the same bytes for the same step is answered from the record.
    if (state === 'STORED') return result;
    try {
      await this.put(key, content, artifact.mediaType);
    } catch (error) {
      if (error instanceof ExecutionError) this.uploaded(source, error.message);
      throw error;
    }
    await this.stored(
      scope,
      artifact.id,
      result,
      artifact.retentionPolicy,
      uploadedBy,
      source,
      artifact.mediaType,
      started,
    );
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
    const started = this.now();
    const retrieved = (result: string) =>
      this.telemetry.count('af_artifact_retrievals_total', { result });
    const refuse = (error: ExecutionError) => {
      retrieved(error.message);
      return error;
    };
    const invalid = () => refuse(new ExecutionError(403, 'ARTIFACT_RETRIEVAL_INVALID'));
    const [payload, signature, ...rest] = token.split('.');
    if (!payload || !signature || rest.length || !this.deps.verifyRetrieval(payload, signature))
      throw invalid();
    let claim: { a?: unknown; o?: unknown; u?: unknown; s?: unknown; e?: unknown };
    try {
      claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claim;
    } catch {
      throw invalid();
    }
    if (
      typeof claim.a !== 'string' ||
      typeof claim.e !== 'number' ||
      claim.o !== actor.organizationId ||
      claim.u !== actor.id
    )
      throw invalid();
    if (!(this.now() < claim.e))
      throw refuse(new ExecutionError(403, 'ARTIFACT_RETRIEVAL_EXPIRED'));
    const artifact = await this.deps.readableArtifact(actor, claim.a);
    const object = await this.object(actor.organizationId, artifact.id);
    if (!object) throw refuse(new ExecutionError(404, 'ARTIFACT_NOT_FOUND'));
    if (object['state'] === 'DELETED')
      throw refuse(new ExecutionError(410, 'ARTIFACT_CONTENT_DELETED'));
    if (object['state'] !== 'REGISTERED' || object['sha256'] !== claim.s) throw invalid();
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
      this.telemetry.count('af_artifact_integrity_failures_total', { code });
      return refuse(new ExecutionError(409, 'ARTIFACT_INTEGRITY_FAILED'));
    };
    // A row can only ever point inside its own tenant's prefix of this store.
    if (object['store'] !== this.store.name || !key.startsWith(`${actor.organizationId}/`))
      throw await failed('KEY_OUTSIDE_TENANT');
    let content: Buffer | null;
    try {
      content = await this.store.get(key);
    } catch {
      this.storeFailed('get');
      throw refuse(new ExecutionError(503, 'ARTIFACT_STORE_UNAVAILABLE'));
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
    retrieved('retrieved');
    // Each retrieval is its own event in the run's trace, under the artifact.
    this.telemetry.span({
      runId: artifact.runId,
      name: 'artifact.retrieve',
      subject: 'artifact',
      id: `${artifact.id}/retrieval/${claim.e}`,
      parent: { subject: 'artifact', id: artifact.id },
      startTimeMs: started,
      endTimeMs: this.now(),
      attributes: {
        'af.organization.id': actor.organizationId,
        'af.artifact.id': artifact.id,
        'af.artifact.size_bytes': content.byteLength,
        'af.store': this.store.name,
      },
    });
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
      this.storeFailed('delete');
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
      this.db.afterCommit(() => this.telemetry.count('af_artifact_deletions_total', { reason }));
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
