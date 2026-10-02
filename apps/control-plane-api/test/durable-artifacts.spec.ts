import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactRetrieval, ArtifactUpload } from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { MemoryArtifactStore } from '../src/artifacts/artifact-store.js';
import { canonicalManifest, manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { runtimeKeyPair, signedRuntimePost } from './runtime-helpers.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const org = 'org_agents_foundry';
const employeeId = 'employee_qa_demo';
const as = (id: string, role: 'ADMIN' | 'EMPLOYEE', organizationId = org) => ({
  'x-actor-id': id,
  'x-actor-role': role,
  'x-organization-id': organizationId,
});
const keys = { agent: runtimeKeyPair(), other: runtimeKeyPair(), execution: runtimeKeyPair() };
const sha256 = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalManifest(value)).digest('hex');
const DAY = 24 * 60 * 60_000;
const SECRET_MARKER = 'object-store-secret-access-key';

describe('durable artifact storage (ADR 0033)', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let store: MemoryArtifactStore;
  let agentId: string;

  beforeEach(async () => {
    store = new MemoryArtifactStore();
    db = await testDatabase({
      manifestV2Issuance: true,
      genericRuntime: true,
      artifactStore: store,
      runtimeIdentities: [
        ...(['agent', 'other'] as const).map((name) => ({
          id: `runtime-${name}`,
          publicKeySpki: keys[name].spki,
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        })),
        {
          id: 'runtime-execution',
          role: 'execution' as const,
          publicKeySpki: keys.execution.spki,
          organizations: [org],
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
  });
  afterEach(() => db.close());

  const raw = () => rawSql(db);
  const post = (name: keyof typeof keys, path: string, body?: unknown) =>
    signedRuntimePost(app, `runtime-${name}`, keys[name].privateKey, path, body);
  const objects = (where = '') =>
    raw().prepare(`SELECT * FROM agent_artifact_objects ${where} ORDER BY seq`).all();

  /** A run held by `runtime-agent` with one running tool step. */
  const running = async () => {
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
    // A refused event does not use up its sequence number.
    const emit = (type: string, payload: object, stepId?: string, accepted = true) =>
      post('agent', '/runtime/v1/events', {
        protocol: 'agents-foundry/runtime/v1',
        eventId: randomUUID(),
        runId: run.id,
        threadId: run.threadId,
        ...(stepId ? { stepId } : {}),
        sequence: accepted ? ++sequence : sequence + 1,
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
    const describe = (content: Buffer, overrides: object = {}) => ({
      id: randomUUID(),
      mediaType: 'text/markdown',
      name: 'report.md',
      checksum: { algorithm: 'sha256', value: sha256(content) },
      sizeBytes: content.byteLength,
      retentionPolicy: 'STANDARD_30D',
      ...overrides,
    });
    const upload = (
      content: Buffer,
      overrides: object = {},
      from: 'agent' | 'other' = 'agent',
      scope: object = {},
    ) => {
      const artifact = describe(content, overrides);
      return {
        artifact,
        response: post(from, '/runtime/v1/artifacts', {
          protocol: 'agents-foundry/runtime/v1',
          correlation: { ...correlation, stepId, ...scope },
          artifact,
          content: content.toString('base64'),
        }),
      };
    };
    const register = (
      artifact: ReturnType<typeof describe>,
      storageReference: string,
      overrides: object = {},
      accepted = true,
    ) =>
      emit(
        'artifact.created',
        { artifact: { ...artifact, type: 'report', storageReference, ...overrides } },
        stepId,
        accepted,
      );
    /** Upload and register one artifact; returns its id and storage key. */
    const stored = async (text: string, overrides: object = {}) => {
      const content = Buffer.from(text);
      const { artifact, response } = upload(content, overrides);
      const body = (await response.expect(201)).body as ArtifactUpload;
      await register(artifact, body.storageReference).expect(201);
      return { artifact, content, key: body.storageReference.replace(/^artifact:\/\/[^/]+\//, '') };
    };
    return { run, correlation, stepId, emit, upload, register, stored, describe };
  };

  const retrieval = async (artifactId: string, headers = as(employeeId, 'EMPLOYEE')) =>
    (
      await request(app)
        .post(`/api/execution/v1/artifacts/${artifactId}/retrievals`)
        .set(headers)
        .expect(201)
    ).body as ArtifactRetrieval;
  const download = (path: string, headers = as(employeeId, 'EMPLOYEE')) =>
    request(app)
      .get(path)
      .set(headers)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          // Errors are JSON; content is bytes.
          done(
            null,
            /json/.test(String(response.headers['content-type']))
              ? JSON.parse(body.toString('utf8'))
              : body,
          );
        });
      });

  it('stores uploaded bytes outside PostgreSQL and registers only what it verified', async () => {
    const { run, correlation, stepId, upload, register } = await running();
    const content = Buffer.from('# Test report\n\nAll checks passed.');
    const { artifact, response } = upload(content);
    const uploaded = (await response.expect(201)).body as ArtifactUpload;
    const key = `${org}/${run.id}/${artifact.id}`;
    expect(uploaded).toEqual({
      artifactId: artifact.id,
      storageReference: `artifact://memory-store/${key}`,
      checksum: artifact.checksum,
      sizeBytes: content.byteLength,
    });
    expect(store.objects.get(key)!.equals(content)).toBe(true);
    // PostgreSQL has the metadata, and no column that could hold the bytes.
    const [row] = await objects();
    expect(row).toMatchObject({
      artifact_id: artifact.id,
      organization_id: org,
      run_id: run.id,
      thread_id: run.threadId,
      storage_key: key,
      store: 'memory-store',
      media_type: 'text/markdown',
      sha256: sha256(content),
      retention_class: 'STANDARD_30D',
      state: 'STORED',
      uploaded_by: 'runtime-agent',
    });
    expect(Number(row!['size_bytes'])).toBe(content.byteLength);
    expect(Date.parse(String(row!['expires_at'])) - Date.parse(String(row!['created_at']))).toBe(
      30 * DAY,
    );
    expect(JSON.stringify(await objects())).not.toContain('All checks passed');
    expect(
      (
        await raw()
          .prepare(
            `SELECT data_type FROM information_schema.columns
             WHERE table_name IN ('agent_artifact_objects','agent_artifacts') AND data_type='bytea'`,
          )
          .all()
      ).length,
    ).toBe(0);

    // The same bytes again are answered from the record; other bytes under that id are not.
    const again = post('agent', '/runtime/v1/artifacts', {
      protocol: 'agents-foundry/runtime/v1',
      correlation: { ...correlation, stepId },
      artifact,
      content: content.toString('base64'),
    });
    expect((await again.expect(201)).body).toEqual(uploaded);
    const other = Buffer.from('different bytes');
    await upload(other, { id: artifact.id }).response.expect(409, {
      error: 'ARTIFACT_ALREADY_EXISTS',
    });
    expect(store.objects.get(key)!.equals(content)).toBe(true);

    // Registration must match the stored object in every respect.
    const reference = uploaded.storageReference;
    for (const wrong of [
      { checksum: { algorithm: 'sha256', value: sha256('other') } },
      { sizeBytes: content.byteLength + 1 },
      { mediaType: 'text/plain' },
      { retentionPolicy: 'LEGAL_HOLD' },
      { id: randomUUID() },
    ])
      await register(artifact, reference, wrong, false).expect(409, {
        error: 'ARTIFACT_OBJECT_MISMATCH',
      });
    await register(
      artifact,
      `artifact://memory-store/${org}/${run.id}/${randomUUID()}`,
      {},
      false,
    ).expect(409, { error: 'ARTIFACT_OBJECT_MISMATCH' });
    expect((await objects())[0]!['state']).toBe('STORED');
    await register(artifact, reference).expect(201);
    expect((await objects())[0]).toMatchObject({ state: 'REGISTERED' });
    const detail = (await demoRequest(app).get(`/api/execution/v1/runs/${run.id}`).expect(200))
      .body;
    expect(detail.artifacts).toEqual([
      expect.objectContaining({
        id: artifact.id,
        name: 'report.md',
        content: expect.objectContaining({ state: 'AVAILABLE', deletedAt: null }),
      }),
    ]);
    // Browsers never see where the bytes are.
    expect(JSON.stringify(detail)).not.toContain('artifact://');
    expect(JSON.stringify(detail)).not.toContain(key);
  });

  it('enforces hashes and sizes on upload and refuses runtimes that do not hold the run', async () => {
    const { run, upload, emit, stepId, register, describe } = await running();
    const content = Buffer.from('evidence');
    await upload(content, {
      checksum: { algorithm: 'sha256', value: sha256('something else') },
    }).response.expect(400, { error: 'ARTIFACT_DIGEST_MISMATCH' });
    await upload(content, { sizeBytes: content.byteLength - 1 }).response.expect(400, {
      error: 'ARTIFACT_SIZE_MISMATCH',
    });
    for (const name of ['../escape.md', 'a/b.md', '.hidden', 'x'.repeat(121), 'a..b'])
      await upload(content, { name }).response.expect(400);
    await upload(content, { sizeBytes: 17 * 1024 * 1024 }).response.expect(400);
    // Another agent runtime, the wrong role, and correlations that are not the held run's.
    await upload(content, {}, 'other').response.expect(403, { error: 'RUNTIME_LEASE_REQUIRED' });
    const { artifact } = upload(content);
    await post('execution', '/runtime/v1/artifacts', {
      protocol: 'agents-foundry/runtime/v1',
      correlation: {
        organizationId: org,
        employeeId,
        agentId,
        threadId: run.threadId,
        runId: run.id,
        stepId,
      },
      artifact,
      content: content.toString('base64'),
    }).expect(403, { error: 'RUNTIME_ROLE_FORBIDDEN' });
    await upload(content, {}, 'agent', { organizationId: 'org_other' }).response.expect(409, {
      error: 'RUNTIME_CORRELATION_MISMATCH',
    });
    await upload(content, {}, 'agent', { employeeId: 'employee_other' }).response.expect(409, {
      error: 'RUNTIME_CORRELATION_MISMATCH',
    });
    await upload(content, {}, 'agent', { stepId: randomUUID() }).response.expect(404, {
      error: 'STEP_NOT_FOUND',
    });
    expect(await objects()).toEqual([]);
    expect(store.objects.size).toBe(0);

    // A reference to this store for bytes that were never uploaded is refused; a runtime's
    // own store is accepted as unmanaged content that cannot be retrieved.
    const never = describe(content);
    await register(never, `artifact://memory-store/${org}/${run.id}/${never.id}`, {}, false).expect(
      409,
      {
        error: 'ARTIFACT_OBJECT_MISMATCH',
      },
    );
    const local = describe(content);
    await register(local, `artifact://local-runtime/${org}/${run.id}/${local.id}/report.md`).expect(
      201,
    );
    const detail = (await demoRequest(app).get(`/api/execution/v1/runs/${run.id}`).expect(200))
      .body;
    expect(detail.artifacts[0].content.state).toBe('UNMANAGED');
    await request(app)
      .post(`/api/execution/v1/artifacts/${local.id}/retrievals`)
      .set(as(employeeId, 'EMPLOYEE'))
      .expect(409, { error: 'ARTIFACT_CONTENT_UNMANAGED' });
    // A deployment can refuse unmanaged content outright.
    (db.artifacts as unknown as { deps: { requireManaged: boolean } }).deps.requireManaged = true;
    const refused = describe(content);
    await register(
      refused,
      `artifact://local-runtime/${org}/${run.id}/${refused.id}/report.md`,
      {},
      false,
    ).expect(409, { error: 'ARTIFACT_STORE_UNMANAGED' });

    // Once the step ends nothing more can be stored for it.
    await emit('step.completed', {}, stepId).expect(201);
    await upload(content).response.expect(409, { error: 'STEP_NOT_RUNNING' });
  });

  it('accepts evidence from an execution runtime only under a grant it signed', async () => {
    const { run, correlation, stepId, register } = await running();
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
    ).body;
    const content = Buffer.from('PNG-bytes-of-a-screenshot');
    const artifact = {
      id: randomUUID(),
      mediaType: 'image/png',
      name: 'screenshot.png',
      checksum: { algorithm: 'sha256', value: sha256(content) },
      sizeBytes: content.byteLength,
      retentionPolicy: 'STANDARD_30D',
    };
    const body = { grant, artifact, content: content.toString('base64') };
    // Agent runtimes cannot use the grant route, and a grant cannot be altered or invented.
    await post('agent', '/runtime/v1/artifacts/execution', body).expect(403, {
      error: 'RUNTIME_ROLE_FORBIDDEN',
    });
    const forged = structuredClone(grant);
    forged.payload.correlation.runId = randomUUID();
    await post('execution', '/runtime/v1/artifacts/execution', { ...body, grant: forged }).expect(
      403,
      { error: 'ARTIFACT_GRANT_INVALID' },
    );
    const unrecorded = db.signer.signExecutionGrant({ ...grant.payload, grantId: randomUUID() });
    await post('execution', '/runtime/v1/artifacts/execution', {
      ...body,
      grant: unrecorded,
    }).expect(403, { error: 'ARTIFACT_GRANT_INVALID' });
    await post('execution', '/runtime/v1/artifacts/execution', { ...body, grant: {} }).expect(403, {
      error: 'ARTIFACT_GRANT_INVALID',
    });
    await post('execution', '/runtime/v1/artifacts/execution', {
      ...body,
      artifact: { ...artifact, checksum: { algorithm: 'sha256', value: sha256('x') } },
    }).expect(400, { error: 'ARTIFACT_DIGEST_MISMATCH' });
    expect(store.objects.size).toBe(0);

    const uploaded = (await post('execution', '/runtime/v1/artifacts/execution', body).expect(201))
      .body as ArtifactUpload;
    // The tenant, run, step and tool call are the grant's.
    expect((await objects())[0]).toMatchObject({
      organization_id: org,
      run_id: run.id,
      step_id: stepId,
      tool_call_id: full.toolCallId,
      uploaded_by: 'runtime-execution',
      state: 'STORED',
    });
    await register({ ...artifact }, uploaded.storageReference, { type: 'screenshot' }).expect(201);
    const permission = await retrieval(artifact.id);
    expect(((await download(permission.path).expect(200)).body as Buffer).equals(content)).toBe(
      true,
    );
  });

  it('retrieves content only for the right person, briefly, and only if the hash still holds', async () => {
    const { stored } = await running();
    const { artifact, content, key } = await stored('confidential test evidence');
    const permission = await retrieval(artifact.id);
    expect(permission.artifactId).toBe(artifact.id);
    expect(permission.path).toMatch(/^\/api\/execution\/v1\/artifact-content\//);
    expect(Date.parse(permission.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    // The path holds no storage key and no object-store location.
    expect(permission.path).not.toContain(key);
    expect(
      Buffer.from(permission.path.split('/').at(-1)!.split('.')[0]!, 'base64url').toString(),
    ).not.toContain(key);

    const response = await download(permission.path).expect(200);
    expect((response.body as Buffer).equals(content)).toBe(true);
    expect(response.headers['content-disposition']).toBe('attachment; filename="report.md"');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');

    // An administrator of the same organization may read run evidence, with their own permission.
    const admin = as('admin_demo', 'ADMIN');
    await download((await retrieval(artifact.id, admin)).path, admin).expect(200);
    // The employee's permission is no use to anyone else, in or out of the organization.
    await download(permission.path, admin).expect(403, { error: 'ARTIFACT_RETRIEVAL_INVALID' });
    // Whoever else is signed in: a colleague, or anyone in another organization, even with
    // the same identifiers. (Checked on the service: sign-in rejects unknown people earlier.)
    const token = permission.path.split('/').at(-1)!;
    for (const stranger of [
      { id: 'employee_other', role: 'EMPLOYEE' as const, organizationId: org },
      { id: 'admin_other', role: 'ADMIN' as const, organizationId: 'org_other' },
      { id: employeeId, role: 'EMPLOYEE' as const, organizationId: 'org_other' },
      { id: 'admin_demo', role: 'ADMIN' as const, organizationId: 'org_other' },
    ]) {
      await expect(db.artifacts.requestRetrieval(stranger, artifact.id)).rejects.toMatchObject({
        status: 404,
        message: 'ARTIFACT_NOT_FOUND',
      });
      await expect(db.artifacts.retrieve(stranger, token)).rejects.toMatchObject({
        status: 403,
        message: 'ARTIFACT_RETRIEVAL_INVALID',
      });
    }
    await download(permission.path, as('employee_other', 'EMPLOYEE')).expect(403);
    await request(app).get(permission.path).expect(401);

    // Guessing never helps: there is no route that takes a storage key, and a permission
    // cannot be edited or forged.
    await download(`/api/execution/v1/artifact-content/${key}`).expect(404);
    await download(`/api/execution/v1/artifact-content/${encodeURIComponent(key)}`).expect(403);
    const [payload, signature] = permission.path.split('/').at(-1)!.split('.') as [string, string];
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const reissue = (change: object) =>
      `/api/execution/v1/artifact-content/${Buffer.from(JSON.stringify({ ...claim, ...change })).toString('base64url')}.${signature}`;
    for (const forged of [
      reissue({ u: 'admin_demo' }),
      reissue({ e: claim.e + 3_600_000 }),
      reissue({ a: randomUUID() }),
      `/api/execution/v1/artifact-content/${payload}.${'A'.repeat(signature.length)}`,
      `/api/execution/v1/artifact-content/${payload}`,
      `/api/execution/v1/artifact-content/${payload}.${signature}.x`,
    ])
      await download(forged).expect(403, { error: 'ARTIFACT_RETRIEVAL_INVALID' });

    // A permission expires after a minute.
    const clock = db.artifacts as unknown as { now: () => number };
    const realNow = clock.now;
    clock.now = () => Date.now() + 61_000;
    await download(permission.path).expect(403, { error: 'ARTIFACT_RETRIEVAL_EXPIRED' });
    clock.now = realNow;

    // Bytes that no longer match the recorded hash are never served.
    store.objects.set(key, Buffer.from('confidential test evidence, altered'));
    await download(permission.path).expect(409, { error: 'ARTIFACT_INTEGRITY_FAILED' });
    store.objects.set(key, Buffer.from('confidential test evidencE'));
    await download(permission.path).expect(409, { error: 'ARTIFACT_INTEGRITY_FAILED' });
    store.objects.delete(key);
    await download(permission.path).expect(409, { error: 'ARTIFACT_INTEGRITY_FAILED' });
    store.objects.set(key, content);
    await download(permission.path).expect(200);

    const audit = (
      await raw()
        .prepare("SELECT event_type, metadata FROM audit_events WHERE event_type LIKE 'artifact.%'")
        .all()
    ).map((event) => event['event_type']);
    expect(audit.filter((type) => type === 'artifact.integrity_failed')).toHaveLength(3);
    expect(audit.filter((type) => type === 'artifact.retrieved')).toHaveLength(3);
    expect(audit).toContain('artifact.stored');
  });

  it('keeps one tenant from reaching or overwriting another tenant’s objects', async () => {
    const { stored, upload } = await running();
    const { artifact, content, key } = await stored('alpha evidence');
    // Forced row-level security on the metadata.
    expect(
      await raw()
        .prepare(
          `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='agent_artifact_objects'`,
        )
        .all(),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, policies: 1 }]);
    const visible = (organizationId: string) =>
      db.store.tenant(organizationId, () =>
        db.store.all('SELECT artifact_id FROM agent_artifact_objects'),
      );
    expect(await visible(org)).toHaveLength(1);
    expect(await visible('org_other')).toEqual([]);
    expect(
      await db.store.tenant('org_other', () =>
        db.store.run(
          "UPDATE agent_artifact_objects SET state='DELETED', deleted_at=now(), deletion_reason='X_Y'",
        ),
      ),
    ).toEqual({ changes: 0 });
    // Another tenant cannot record an object that points at this tenant's key.
    await expect(
      db.store.tenant('org_other', () =>
        db.store.run(
          `INSERT INTO agent_artifact_objects (artifact_id,organization_id,thread_id,run_id,step_id,store,
           storage_key,media_type,size_bytes,sha256,retention_class,state,uploaded_by,created_at,expires_at)
           SELECT ?, organization_id, thread_id, run_id, step_id, store, storage_key || '-x', media_type,
           size_bytes, sha256, retention_class, 'STORED', uploaded_by, now(), now() + interval '1 day'
           FROM agent_artifact_objects`,
          randomUUID(),
        ),
      ),
    ).resolves.toEqual({ changes: 0 });
    // An artifact id is taken once, whoever asks; its key is always under the uploader's tenant.
    await upload(Buffer.from('overwrite attempt'), { id: artifact.id }).response.expect(409, {
      error: 'ARTIFACT_ALREADY_EXISTS',
    });
    expect(store.objects.get(key)!.equals(content)).toBe(true);
    expect([...store.objects.keys()].every((stored) => stored.startsWith(`${org}/`))).toBe(true);

    // A row cannot be repointed at another tenant's object, even by the platform role.
    store.objects.set('org_other/run/secret', Buffer.from('beta evidence'));
    await expect(
      raw()
        .prepare('UPDATE agent_artifact_objects SET storage_key=? WHERE artifact_id=?')
        .run('org_other/run/secret', artifact.id),
    ).rejects.toThrow(/ARTIFACT_OBJECT_IMMUTABLE/);
    // And a row that somehow did would not be followed: retrieval checks the tenant prefix.
    const object = (
      db.artifacts as unknown as {
        object: (organizationId: string, id: string) => Promise<Record<string, unknown>>;
      }
    ).object.bind(db.artifacts);
    (db.artifacts as unknown as { object: unknown }).object = async (
      organizationId: string,
      id: string,
    ) => ({ ...(await object(organizationId, id)), storage_key: 'org_other/run/secret' });
    const permission = await retrieval(artifact.id);
    const refused = await download(permission.path).expect(409);
    expect(refused.body).toEqual({ error: 'ARTIFACT_INTEGRITY_FAILED' });
  });

  it('enforces retention: bytes are deleted and the lifecycle is recorded', async () => {
    const { run, stored, upload } = await running();
    const standard = await stored('thirty days');
    const brief = await stored('one day', { retentionPolicy: 'EPHEMERAL', name: 'log.txt' });
    const held = await stored('legal hold', { retentionPolicy: 'LEGAL_HOLD', name: 'held.md' });
    const orphan = upload(Buffer.from('never registered'), { name: 'orphan.md' });
    await orphan.response.expect(201);
    expect(store.objects.size).toBe(4);

    // Nothing is due yet.
    expect(await db.artifacts.enforceRetention()).toBe(0);
    // After a day: the ephemeral artifact and the upload no run registered.
    expect(await db.artifacts.enforceRetention(Date.now() + DAY + 60_000)).toBe(2);
    expect([...store.objects.keys()].sort()).toEqual([held.key, standard.key].sort());
    // After thirty: the standard one. A legal hold is never removed.
    expect(await db.artifacts.enforceRetention(Date.now() + 31 * DAY)).toBe(1);
    expect(await db.artifacts.enforceRetention(Date.now() + 400 * DAY)).toBe(0);
    expect([...store.objects.keys()]).toEqual([held.key]);

    const rows = new Map((await objects()).map((row) => [row['artifact_id'], row]));
    expect(rows.get(standard.artifact.id)).toMatchObject({
      state: 'DELETED',
      deletion_reason: 'RETENTION_EXPIRED',
    });
    expect(rows.get(brief.artifact.id)).toMatchObject({
      state: 'DELETED',
      deletion_reason: 'RETENTION_EXPIRED',
    });
    expect(rows.get(orphan.artifact.id)).toMatchObject({
      state: 'DELETED',
      deletion_reason: 'NEVER_REGISTERED',
    });
    expect(rows.get(held.artifact.id)).toMatchObject({ state: 'REGISTERED', expires_at: null });
    for (const id of [standard.artifact.id, brief.artifact.id])
      expect(rows.get(id)!['deleted_at']).not.toBeNull();

    // The metadata stays and says what happened; the content is gone for everyone.
    const detail = (await demoRequest(app).get(`/api/execution/v1/runs/${run.id}`).expect(200))
      .body;
    const states = Object.fromEntries(
      detail.artifacts.map((item: { id: string; content: { state: string } }) => [
        item.id,
        item.content.state,
      ]),
    );
    expect(states).toEqual({
      [standard.artifact.id]: 'DELETED',
      [brief.artifact.id]: 'DELETED',
      [held.artifact.id]: 'AVAILABLE',
    });
    await request(app)
      .post(`/api/execution/v1/artifacts/${standard.artifact.id}/retrievals`)
      .set(as(employeeId, 'EMPLOYEE'))
      .expect(410, { error: 'ARTIFACT_CONTENT_DELETED' });
    const permission = await retrieval(held.artifact.id);
    await download(permission.path).expect(200);
    const deleted = await raw()
      .prepare("SELECT metadata FROM audit_events WHERE event_type='artifact.deleted'")
      .all();
    expect(deleted).toHaveLength(3);

    // Lifecycle rows are append-forward: no resurrection, no rewriting, no removal.
    await expect(
      raw()
        .prepare(
          "UPDATE agent_artifact_objects SET state='REGISTERED', deleted_at=NULL, deletion_reason=NULL WHERE artifact_id=?",
        )
        .run(standard.artifact.id),
    ).rejects.toThrow(/ARTIFACT_OBJECT_TRANSITION_INVALID/);
    await expect(
      raw()
        .prepare('UPDATE agent_artifact_objects SET sha256=? WHERE artifact_id=?')
        .run(sha256('x'), held.artifact.id),
    ).rejects.toThrow(/ARTIFACT_OBJECT_IMMUTABLE/);
    await expect(raw().prepare('DELETE FROM agent_artifact_objects').run()).rejects.toThrow(
      /ARTIFACT_OBJECT_RETAINED/,
    );
  });

  it('does not record a deletion while the bytes are still there', async () => {
    const { stored } = await running();
    const { artifact, key } = await stored('still here');
    const remove = store.delete.bind(store);
    store.delete = async () => {
      throw new Error(`store down: ${SECRET_MARKER}`);
    };
    expect(await db.artifacts.enforceRetention(Date.now() + 31 * DAY)).toBe(0);
    expect((await objects())[0]).toMatchObject({ artifact_id: artifact.id, state: 'REGISTERED' });
    expect(store.objects.has(key)).toBe(true);
    store.delete = remove;
    expect(await db.artifacts.enforceRetention(Date.now() + 31 * DAY)).toBe(1);
    expect(store.objects.has(key)).toBe(false);
    expect(JSON.stringify(await raw().prepare('SELECT * FROM audit_events').all())).not.toContain(
      SECRET_MARKER,
    );
  });

  it('answers a failing store without leaking it, and keeps the upload retryable', async () => {
    const { upload, correlation, stepId } = await running();
    const put = store.put.bind(store);
    store.put = async () => {
      throw new Error(`cannot reach bucket with ${SECRET_MARKER}`);
    };
    const content = Buffer.from('retry me');
    const first = upload(content);
    const failed = await first.response.expect(503);
    expect(failed.body).toEqual({ error: 'ARTIFACT_STORE_UNAVAILABLE' });
    expect((await objects())[0]).toMatchObject({ state: 'PENDING' });
    store.put = put;
    await post('agent', '/runtime/v1/artifacts', {
      protocol: 'agents-foundry/runtime/v1',
      correlation: { ...correlation, stepId },
      artifact: first.artifact,
      content: content.toString('base64'),
    }).expect(201);
    expect((await objects())[0]).toMatchObject({ state: 'STORED' });
    expect(store.objects.size).toBe(1);
  });
});
