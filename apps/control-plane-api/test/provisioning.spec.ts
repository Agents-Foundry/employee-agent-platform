import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import rawRequest from 'supertest';
import { demoRequest as request, createDemoApp as createApp } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { evaluatePolicy } from '../../../packages/policy-engine/src/index.js';
import { verifyManifest } from '../../employee-desktop/src/app/verify-manifest.js';

const org = 'org_agents_foundry';
const employee = {
  'x-actor-id': 'employee_qa_demo',
  'x-actor-role': 'EMPLOYEE',
  'x-organization-id': org,
};
const admin = { 'x-actor-id': 'admin_demo', 'x-actor-role': 'ADMIN', 'x-organization-id': org };
const input = {
  blueprintId: 'engineering.qa-engineer',
  blueprintVersion: '1.1.0',
  provider: 'test-provider',
  model: 'test-model',
  credentialMode: 'EMPLOYEE_BYOK',
  answers: {
    projectName: 'Pilot',
    repositoryUrl: 'https://example.com/repo',
    qaUrl: 'https://qa.example.com',
    issueTracker: ['Jira'],
    sourceControl: ['GitHub'],
    testingTechnologies: ['Playwright'],
  },
};

describe('blueprint provisioning', () => {
  let db: ControlPlaneDatabase;
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:');
  });
  afterEach(() => db.close());

  async function submit(app = createApp(db)) {
    return (await request(app).post('/api/provisioning').set(employee).send(input).expect(201))
      .body;
  }

  it('issues a verified, owned manifest and records lifecycle events atomically', async () => {
    const app = createApp(db);
    const pending = await submit(app);
    expect(db.getBootstrap().agents).toHaveLength(1);
    const result = await request(app)
      .post(`/api/provisioning/${pending.id}/decision`)
      .set(admin)
      .send({ decision: 'APPROVED', reason: 'QA pilot approved' })
      .expect(200);
    const { manifest } = result.body;
    expect(db.signer.verify(manifest)).toBe(true);
    expect(manifest.payload.answers).toEqual(input.answers);
    expect(manifest.payload.capabilities).toContainEqual({
      action: 'qa.execute_playwright',
      outcome: 'REQUIRE_APPROVAL',
    });
    expect(manifest.payload.capabilities).toContainEqual({
      action: 'production.deploy',
      outcome: 'DENY',
    });
    const expected = {
      agentId: manifest.payload.agentId,
      employeeId: employee['x-actor-id'],
      organizationId: org,
    };
    expect(await verifyManifest(manifest, db.signer.verificationKey, expected)).toBe(true);
    expect(
      await verifyManifest(manifest, db.signer.verificationKey, {
        ...expected,
        employeeId: 'someone-else',
      }),
    ).toBe(false);
    const changed = structuredClone(manifest);
    changed.payload.model.model = 'tampered';
    expect(db.signer.verify(changed)).toBe(false);
    expect(await verifyManifest(changed, db.signer.verificationKey, expected)).toBe(false);
    expect(await verifyManifest(manifest, new ManifestSigner().verificationKey, expected)).toBe(
      false,
    );
    expect(db.signer.verify({ ...manifest, keyId: 'wrong-key' })).toBe(false);
    expect(db.signer.verify({ ...manifest, algorithm: 'none' } as typeof manifest)).toBe(false);
    await request(app)
      .get(`/api/agents/${manifest.payload.agentId}/manifest`)
      .set(employee)
      .expect(200);
    expect(() => db.getManifest(manifest.payload.agentId, 'another-org')).toThrow(
      'MANIFEST_NOT_FOUND',
    );
    expect(() => db.getManifest(manifest.payload.agentId, org, 'another-employee')).toThrow(
      'MANIFEST_NOT_FOUND',
    );
    const conversation = await request(app)
      .post('/api/conversations')
      .send({
        employeeId: employee['x-actor-id'],
        agentId: manifest.payload.agentId,
        title: 'Provisioned QA',
      })
      .expect(201);
    const run = await request(app)
      .post('/api/qa/runs')
      .send({
        employeeId: employee['x-actor-id'],
        conversationId: conversation.body.id,
        storyKey: 'STORY-142',
        targetUrl: input.answers.qaUrl,
      })
      .expect(202);
    expect(run.body.run.status).toBe('AWAITING_APPROVAL');
    expect(db.getBootstrap().agents).toHaveLength(2);
    const events = (await request(app).get('/api/lifecycle-events').set(admin).expect(200)).body;
    expect(events.map((event: { type: string }) => event.type).sort()).toEqual([
      'agent.manifest.issued',
      'provisioning.approved',
      'provisioning.requested',
    ]);
    await request(app)
      .post(`/api/provisioning/${pending.id}/decision`)
      .set(admin)
      .send({ decision: 'REJECTED', reason: 'too late' })
      .expect(409);
    expect(db.listLifecycleEvents(org)).toHaveLength(3);
  });

  it('validates blueprint versions, required answers, URLs, selections, and forbids capability overrides', async () => {
    const app = createApp(db);
    for (const body of [
      { ...input, blueprintVersion: '0.0.0' },
      { ...input, answers: {} },
      { ...input, requestedCapabilities: [{ action: 'production.deploy', outcome: 'ALLOW' }] },
      { ...input, answers: { ...input.answers, qaUrl: 'javascript:alert(1)' } },
      { ...input, answers: { ...input.answers, repositoryUrl: 'https://user:secret@example.com' } },
      { ...input, answers: { ...input.answers, sourceControl: ['Unknown'] } },
      { ...input, answers: { ...input.answers, projectName: ' ' } },
    ])
      await request(app).post('/api/provisioning').set(employee).send(body).expect(400);
    expect(db.listProvisioning(org)).toHaveLength(0);
    expect(db.listLifecycleEvents(org)).toHaveLength(0);
    expect(evaluatePolicy('unknown.action').outcome).toBe('DENY');
    expect(evaluatePolicy('__proto__').outcome).toBe('DENY');
  });

  it('rejects unauthenticated, cross-tenant, non-admin and self decisions', async () => {
    const app = createApp(db);
    const pending = await submit(app);
    await rawRequest(app).get('/api/provisioning').expect(401);
    await request(app)
      .get('/api/provisioning')
      .set({ ...employee, 'x-organization-id': 'other' })
      .expect(403);
    await request(app)
      .post(`/api/provisioning/${pending.id}/decision`)
      .set(employee)
      .send({ decision: 'APPROVED', reason: 'self' })
      .expect(403);
    await request(app)
      .post(`/api/provisioning/${pending.id}/decision`)
      .set({ ...employee, 'x-actor-role': 'ADMIN' })
      .send({ decision: 'APPROVED', reason: 'spoof' })
      .expect(403);
    await request(app).get('/api/lifecycle-events').set(employee).expect(403);
    expect(() =>
      db.decideProvisioning(pending.id, org, employee['x-actor-id'], 'APPROVED', 'self'),
    ).toThrow('SELF_APPROVAL_FORBIDDEN');
    expect(db.listProvisioning(org)[0].status).toBe('PENDING');
  });

  it('rejection creates no agent or manifest', async () => {
    const app = createApp(db);
    const pending = await submit(app);
    const result = await request(app)
      .post(`/api/provisioning/${pending.id}/decision`)
      .set(admin)
      .send({ decision: 'REJECTED', reason: 'Needs a dedicated QA environment' })
      .expect(200);
    expect(result.body.request.status).toBe('REJECTED');
    expect(result.body.manifest).toBeUndefined();
    expect(db.getBootstrap().agents).toHaveLength(1);
    expect(db.listLifecycleEvents(org)).toHaveLength(2);
  });

  it('rolls back a failed signing operation without consuming the request', async () => {
    const pending = await submit();
    const sign = vi.spyOn(db.signer, 'sign').mockImplementationOnce(() => {
      throw new Error('SIGNING_UNAVAILABLE');
    });
    expect(() => db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Pilot')).toThrow(
      'SIGNING_UNAVAILABLE',
    );
    sign.mockRestore();
    expect(db.listProvisioning(org)[0].status).toBe('PENDING');
    expect(db.getBootstrap().agents).toHaveLength(1);
    expect(db.listLifecycleEvents(org)).toHaveLength(1);
    expect(
      db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Retry').manifest,
    ).toBeDefined();
  });

  it('persists signing identity and manifests through restart, and fails closed on stored tampering', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agents-foundry-signing-'));
    const path = join(directory, 'test.db');
    let persistent: ControlPlaneDatabase | undefined;
    try {
      persistent = new ControlPlaneDatabase(path);
      const pending = persistent.requestProvisioning(employee['x-actor-id'], {
        ...input,
        credentialMode: 'EMPLOYEE_BYOK',
      });
      const manifest = persistent.decideProvisioning(
        pending.id,
        org,
        'admin_demo',
        'APPROVED',
        'Pilot',
      ).manifest!;
      const keyId = persistent.signer.verificationKey.keyId;
      persistent.close();
      persistent = new ControlPlaneDatabase(path);
      expect(persistent.signer.verificationKey.keyId).toBe(keyId);
      const agentId = manifestSubject(manifest.payload).agentId;
      expect(persistent.getManifest(agentId, org)).toEqual(manifest);
      persistent.close();
      persistent = undefined;
      const raw = new DatabaseSync(path);
      try {
        raw
          .prepare('UPDATE agent_manifests SET body = ?')
          .run(JSON.stringify({ ...manifest, signature: 'invalid' }));
      } finally {
        raw.close();
      }
      persistent = new ControlPlaneDatabase(path);
      expect(() => persistent!.getManifest(agentId, org)).toThrow('MANIFEST_INVALID');
    } finally {
      persistent?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
