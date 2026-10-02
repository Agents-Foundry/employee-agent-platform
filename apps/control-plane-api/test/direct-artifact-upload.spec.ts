import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArtifactUpload,
  ArtifactUploadAuthorization,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import {
  MemoryArtifactStore,
  S3ArtifactStore,
  signObjectStoreRequest,
  type ArtifactStore,
} from '../src/artifacts/artifact-store.js';
import { canonicalManifest, manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { MAX_DIRECT_ARTIFACT_BYTES } from '../../../packages/contracts/src/artifacts.js';
import { runtimeKeyPair, signedRuntimePost, signedRuntimePut } from './runtime-helpers.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const org = 'org_agents_foundry';
const employeeId = 'employee_qa_demo';
const employeeHeaders = {
  'x-actor-id': employeeId,
  'x-actor-role': 'EMPLOYEE',
  'x-organization-id': org,
};
const keys = {
  agent: runtimeKeyPair(),
  execution: runtimeKeyPair(),
  other: runtimeKeyPair(),
  foreign: runtimeKeyPair(),
};
const sha256 = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalManifest(value)).digest('hex');
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'store-secret-key-value-xyz' };
const NOW = new Date('2026-10-02T10:00:00Z');

/**
 * A bucket that behaves like S3 for signed requests: it recomputes the signature from what
 * actually arrived (key, media type, length and payload hash) and refuses anything else.
 */
function bucket() {
  const objects = new Map<string, Buffer>();
  const refused: string[] = [];
  const serve = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const signed: Record<string, string> = {};
    for (const name of ['content-type', 'content-length'])
      if (headers[name] !== undefined) signed[name] = headers[name]!;
    // The length the store sees is the body's, whatever the header claims.
    if (signed['content-length'] !== undefined) signed['content-length'] = String(body.byteLength);
    const expected = signObjectStoreRequest({
      method: String(init?.method),
      url,
      headers: signed,
      payloadSha256: sha256(body),
      region: 'eu-west-1',
      credentials,
      now: NOW,
    })['authorization'];
    if (headers['authorization'] !== expected || headers['x-amz-content-sha256'] !== sha256(body)) {
      refused.push(`${init?.method} ${url.pathname}`);
      return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    }
    if (init?.method === 'PUT') {
      objects.set(url.pathname, body);
      return new Response(null, { status: 200 });
    }
    if (init?.method === 'DELETE') {
      objects.delete(url.pathname);
      return new Response(null, { status: 204 });
    }
    const found = objects.get(url.pathname);
    return found ? new Response(new Uint8Array(found)) : new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  const store = new S3ArtifactStore({
    endpoint: 'https://objects.example.com',
    region: 'eu-west-1',
    bucket: 'af-artifacts',
    credentials: () => credentials,
    fetch: serve,
    now: () => NOW,
  });
  /** What an execution runtime does with a permission: one PUT with exactly its headers. */
  const put = (permission: ArtifactUploadAuthorization, content: Buffer, url = permission.url) =>
    serve(url, {
      method: 'PUT',
      headers: permission.headers,
      body: new Uint8Array(content),
    });
  return { objects, refused, store, put };
}

describe('direct artifact upload (ADR 0037)', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let agentId: string;

  const open = async (store: ArtifactStore) => {
    db = await testDatabase({
      manifestV2Issuance: true,
      genericRuntime: true,
      artifactStore: store,
      runtimeIdentities: [
        {
          id: 'runtime-agent',
          publicKeySpki: keys.agent.spki,
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
        ...(['execution', 'other'] as const).map((name) => ({
          id: `runtime-${name}`,
          role: 'execution' as const,
          publicKeySpki: keys[name].spki,
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        })),
        {
          id: 'runtime-foreign',
          role: 'execution' as const,
          publicKeySpki: keys.foreign.spki,
          organizations: ['org_somebody_else'],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = await db.requestProvisioning(
      employeeId,
      {
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.2.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: {
          projectName: 'Checkout',
          repositoryUrl: 'https://example.com/repo',
          qaUrl: 'https://qa.example.com',
          issueTracker: ['Jira'],
          sourceControl: ['Bitbucket'],
          testingTechnologies: ['Playwright'],
        },
      },
      org,
    );
    agentId = manifestSubject(
      (await db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Pilot')).manifest!
        .payload,
    ).agentId;
    app = createApp(db);
  };
  afterEach(() => db.close());

  const post = (name: keyof typeof keys, path: string, body?: unknown) =>
    signedRuntimePost(app, `runtime-${name}`, keys[name].privateKey, path, body);
  const objects = () =>
    rawSql(db).prepare('SELECT * FROM agent_artifact_objects ORDER BY seq').all();

  /** A running run with one running tool step and a recorded execution grant for it. */
  const granted = async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'x', inputs: {} } })
        .expect(202)
    ).body as { id: string; threadId: string };
    const claim = (await post('agent', '/runtime/v1/commands/claim').expect(200)).body;
    const correlation = {
      organizationId: org,
      employeeId,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    let sequence = 0;
    const emit = (type: string, payload: object, stepId?: string) =>
      post('agent', '/runtime/v1/events', {
        protocol: 'agents-foundry/runtime/v1',
        eventId: randomUUID(),
        runId: run.id,
        threadId: run.threadId,
        ...(stepId ? { stepId } : {}),
        sequence: ++sequence,
        type,
        occurredAt: new Date().toISOString(),
        correlation,
        payload,
      });
    await emit('run.started', { runtimeSessionId: claim.lease.sessionId, kernel: 'test' }).expect(
      201,
    );
    const stepId = randomUUID();
    await emit('step.started', { kind: 'TOOL', title: 'Tool' }, stepId).expect(201);
    const full = { ...correlation, stepId, toolCallId: randomUUID() };
    const operation = {
      kind: 'git.checkout',
      repositoryUrl: 'https://example.com/repo/',
      ref: 'main',
      path: 'repo',
    };
    const decision = (
      await post('agent', '/runtime/v1/actions', {
        protocol: 'agents-foundry/runtime/v1',
        requestId: randomUUID(),
        correlation: full,
        action: 'repository.read',
        toolId: 'repository',
        toolVersion: '1.0.0',
        inputDigest: digest(operation),
        summary: 'x',
        parameters: operation,
      }).expect(200)
    ).body;
    const grant = (
      await post('agent', '/runtime/v1/actions/grant', {
        protocol: 'agents-foundry/runtime/v1',
        requestId: decision.requestId,
        correlation: full,
      }).expect(200)
    ).body as SignedExecutionGrant;
    const register = (artifact: object, storageReference: string) =>
      emit(
        'artifact.created',
        { artifact: { ...artifact, type: 'playwright_trace', storageReference } },
        stepId,
      );
    return { run, grant, stepId, toolCallId: full.toolCallId, emit, register };
  };

  const describeArtifact = (content: Buffer, overrides: object = {}) => ({
    id: randomUUID(),
    mediaType: 'application/zip',
    name: 'trace.zip',
    checksum: { algorithm: 'sha256', value: sha256(content) },
    sizeBytes: content.byteLength,
    retentionPolicy: 'STANDARD_30D',
    ...overrides,
  });
  const authorize = (body: object, as: keyof typeof keys = 'execution') =>
    post(as, '/runtime/v1/artifacts/execution/authorize', body);
  const complete = (body: object, as: keyof typeof keys = 'execution') =>
    post(as, '/runtime/v1/artifacts/execution/complete', body);
  const download = async (artifactId: string) => {
    const permission = (
      await request(app)
        .post(`/api/execution/v1/artifacts/${artifactId}/retrievals`)
        .set(employeeHeaders)
        .expect(201)
    ).body as { path: string };
    const response = await request(app)
      .get(permission.path)
      .set(employeeHeaders)
      .buffer(true)
      .parse((incoming, done) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return response.body as Buffer;
  };

  describe('to an object store', () => {
    let s3: ReturnType<typeof bucket>;
    beforeEach(async () => {
      s3 = bucket();
      await open(s3.store);
    });

    it('authorizes exactly one object, accepts it only after reading it back, and serves it', async () => {
      const { run, grant, stepId, toolCallId, register } = await granted();
      const content = Buffer.alloc(300_000, 7);
      const artifact = describeArtifact(content);
      const permission = (await authorize({ grant, artifact }).expect(201))
        .body as ArtifactUploadAuthorization;
      const key = `${org}/${run.id}/${artifact.id}`;
      expect(permission).toMatchObject({
        artifactId: artifact.id,
        target: 'STORE',
        url: `https://objects.example.com/af-artifacts/${key}`,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(content.byteLength),
          'x-amz-content-sha256': artifact.checksum.value,
        },
      });
      // Minutes, not hours; and a signature, never the store's secret key.
      expect(Date.parse(permission.expiresAt) - NOW.getTime()).toBe(15 * 60_000);
      expect(JSON.stringify(permission)).not.toContain(credentials.secretAccessKey);
      // The object is reserved for the grant's tenant, run, step and tool call before any byte.
      expect((await objects())[0]).toMatchObject({
        artifact_id: artifact.id,
        organization_id: org,
        run_id: run.id,
        step_id: stepId,
        tool_call_id: toolCallId,
        storage_key: key,
        state: 'PENDING',
        uploaded_by: 'runtime-execution',
      });
      // Nothing is there yet, so nothing can be confirmed or registered.
      await complete({ grant, artifactId: artifact.id }).expect(409, {
        error: 'ARTIFACT_CONTENT_MISSING',
      });

      // The store itself refuses anything the permission was not for.
      const other = Buffer.alloc(300_000, 8);
      expect((await s3.put(permission, other)).status).toBe(403);
      expect((await s3.put(permission, content.subarray(0, 1000))).status).toBe(403);
      expect(
        (await s3.put(permission, content, permission.url.replace(artifact.id, randomUUID())))
          .status,
      ).toBe(403);
      expect(
        (
          await s3.put(
            { ...permission, headers: { ...permission.headers, 'content-type': 'text/html' } },
            content,
          )
        ).status,
      ).toBe(403);
      expect(s3.objects.size).toBe(0);
      expect(s3.refused).toHaveLength(4);

      expect((await s3.put(permission, content)).status).toBe(200);
      const stored = (await complete({ grant, artifactId: artifact.id }).expect(201))
        .body as ArtifactUpload;
      expect(stored).toEqual({
        artifactId: artifact.id,
        storageReference: `artifact://object-store/${key}`,
        checksum: artifact.checksum,
        sizeBytes: content.byteLength,
      });
      // Confirming again, or asking for another permission for a stored object, changes nothing.
      expect((await complete({ grant, artifactId: artifact.id }).expect(201)).body).toEqual(stored);
      await authorize({ grant, artifact }).expect(409, { error: 'ARTIFACT_ALREADY_EXISTS' });
      expect((await objects())[0]).toMatchObject({ state: 'STORED' });

      await register(artifact, stored.storageReference).expect(201);
      expect((await download(artifact.id)).equals(content)).toBe(true);
      const audit = await rawSql(db)
        .prepare("SELECT metadata FROM audit_events WHERE event_type='artifact.stored'")
        .all();
      expect(JSON.parse(String(audit[0]!['metadata']))).toMatchObject({
        artifactId: artifact.id,
        direct: true,
      });
    });

    it('removes and records bytes that are not what was declared, however they got there', async () => {
      const { grant } = await granted();
      const content = Buffer.alloc(50_000, 1);
      const artifact = describeArtifact(content);
      const permission = (await authorize({ grant, artifact }).expect(201))
        .body as ArtifactUploadAuthorization;
      // Something wrote other bytes at the key (a store that did not check, or an insider).
      const path = new URL(permission.url).pathname;
      s3.objects.set(path, Buffer.alloc(50_000, 2));
      await complete({ grant, artifactId: artifact.id }).expect(409, {
        error: 'ARTIFACT_DIGEST_MISMATCH',
      });
      expect(s3.objects.has(path)).toBe(false);
      expect((await objects())[0]).toMatchObject({
        state: 'DELETED',
        deletion_reason: 'INTEGRITY_FAILED',
      });
      expect(
        await rawSql(db)
          .prepare(
            "SELECT event_type FROM audit_events WHERE event_type LIKE 'artifact.%' ORDER BY seq",
          )
          .all(),
      ).toEqual([{ event_type: 'artifact.deleted' }, { event_type: 'artifact.integrity_failed' }]);
      // It can never be confirmed or registered afterwards.
      await complete({ grant, artifactId: artifact.id }).expect(404, {
        error: 'ARTIFACT_NOT_FOUND',
      });
    });

    it('authorizes only execution runtimes, for recorded grants, allowed types and sizes, within the run quota', async () => {
      const { grant, run } = await granted();
      const content = Buffer.alloc(2048, 3);
      const artifact = describeArtifact(content);
      await authorize({ grant, artifact }, 'agent').expect(403, {
        error: 'RUNTIME_ROLE_FORBIDDEN',
      });
      await authorize({ grant, artifact }, 'foreign').expect(403, {
        error: 'ARTIFACT_ORGANIZATION_FORBIDDEN',
      });
      const forged = structuredClone(grant);
      forged.payload.correlation.runId = randomUUID();
      await authorize({ grant: forged, artifact }).expect(403, { error: 'ARTIFACT_GRANT_INVALID' });
      const unrecorded = db.signer.signExecutionGrant({ ...grant.payload, grantId: randomUUID() });
      await authorize({ grant: unrecorded, artifact }).expect(403, {
        error: 'ARTIFACT_GRANT_INVALID',
      });
      for (const bad of [
        { mediaType: 'text/html' },
        { mediaType: 'application/x-msdownload' },
        { sizeBytes: 0 },
        { sizeBytes: MAX_DIRECT_ARTIFACT_BYTES + 1 },
        { name: '../trace.zip' },
        { checksum: { algorithm: 'sha256', value: 'not-a-digest' } },
        { extra: true },
      ])
        await authorize({ grant, artifact: { ...artifact, ...bad } }).expect(400);
      expect(await objects()).toEqual([]);

      // Another execution runtime cannot confirm, or re-authorize, somebody else's upload.
      await authorize({ grant, artifact }).expect(201);
      await complete({ grant, artifactId: artifact.id }, 'other').expect(404, {
        error: 'ARTIFACT_NOT_FOUND',
      });
      await complete({ grant, artifactId: randomUUID() }).expect(404, {
        error: 'ARTIFACT_NOT_FOUND',
      });
      // The same artifact id cannot be re-described.
      await authorize({
        grant,
        artifact: { ...artifact, sizeBytes: 4096 },
      }).expect(409, { error: 'ARTIFACT_ALREADY_EXISTS' });

      // A run's direct uploads count against the same quota as everything else it stores.
      const big = (size: number) =>
        describeArtifact(Buffer.alloc(1), {
          sizeBytes: size,
          checksum: { algorithm: 'sha256', value: sha256(randomUUID()) },
        });
      for (let index = 0; index < 3; index += 1)
        await authorize({ grant, artifact: big(MAX_DIRECT_ARTIFACT_BYTES) }).expect(201);
      await authorize({ grant, artifact: big(MAX_DIRECT_ARTIFACT_BYTES) }).expect(409, {
        error: 'ARTIFACT_QUOTA_EXCEEDED',
      });
      // And nothing is authorized once the run has ended.
      await demoRequest(app).post(`/api/execution/v1/runs/${run.id}/cancel`).expect(200);
      await authorize({ grant, artifact: describeArtifact(Buffer.alloc(10, 9)) }).expect(409, {
        error: 'RUN_NOT_RUNNING',
      });
    });
  });

  describe('through the control plane, for a store that cannot authorize uploads', () => {
    let memory: MemoryArtifactStore;
    beforeEach(async () => {
      memory = new MemoryArtifactStore();
      await open(memory);
    });

    it('takes the bytes on a signed, single-purpose path and checks them before storing', async () => {
      const { run, grant, register } = await granted();
      const content = Buffer.alloc(120_000, 5);
      const artifact = describeArtifact(content, { mediaType: 'image/png', name: 'failure.png' });
      const permission = (await authorize({ grant, artifact }).expect(201))
        .body as ArtifactUploadAuthorization;
      expect(permission).toMatchObject({
        target: 'CONTROL_PLANE',
        headers: { 'content-type': 'image/png' },
      });
      expect(permission.url).toMatch(
        /^\/runtime\/v1\/artifact-content\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      expect(Date.parse(permission.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
      const put = (path: string, body: Buffer, as: 'execution' | 'other' | 'agent' = 'execution') =>
        signedRuntimePut(app, `runtime-${as}`, keys[as].privateKey, path, body, 'image/png');

      // Only the runtime it was issued to, only an execution runtime, only an unaltered token.
      await put(permission.url, content, 'other').expect(403, { error: 'ARTIFACT_UPLOAD_INVALID' });
      await put(permission.url, content, 'agent').expect(403, { error: 'RUNTIME_ROLE_FORBIDDEN' });
      const [payload, signature] = permission.url.split('/').at(-1)!.split('.');
      const claim = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
      const altered = Buffer.from(JSON.stringify({ ...claim, n: 10 })).toString('base64url');
      await put(`/runtime/v1/artifact-content/${altered}.${signature}`, content).expect(403, {
        error: 'ARTIFACT_UPLOAD_INVALID',
      });
      // A retrieval signature is not an upload signature.
      const wrongDomain = db.signer.signArtifactRetrieval(payload!);
      await put(`/runtime/v1/artifact-content/${payload}.${wrongDomain}`, content).expect(403, {
        error: 'ARTIFACT_UPLOAD_INVALID',
      });
      // Only the declared bytes.
      await put(permission.url, content.subarray(0, 100)).expect(400, {
        error: 'ARTIFACT_SIZE_MISMATCH',
      });
      await put(permission.url, Buffer.alloc(120_000, 6)).expect(400, {
        error: 'ARTIFACT_DIGEST_MISMATCH',
      });
      expect(memory.objects.size).toBe(0);

      await put(permission.url, content).expect(204);
      expect(memory.objects.get(`${org}/${run.id}/${artifact.id}`)!.equals(content)).toBe(true);
      const stored = (await complete({ grant, artifactId: artifact.id }).expect(201))
        .body as ArtifactUpload;
      // Once stored, the path accepts nothing more.
      await put(permission.url, content).expect(403, { error: 'ARTIFACT_UPLOAD_INVALID' });
      await register({ ...artifact }, stored.storageReference).expect(201);
      expect((await download(artifact.id)).equals(content)).toBe(true);
    });
  });
});
