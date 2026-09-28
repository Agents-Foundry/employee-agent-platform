import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import type { Actor, AdminAgentInput } from '@agents-foundry/contracts';
import { verifyManifest } from '../../employee-desktop/src/app/verify-manifest.js';
import { testDatabase } from './support/database.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
describe('admin-created agent assignments', () => {
  let db: ControlPlaneDatabase, admin: Actor, employees: Actor[], hash: string;
  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });
  beforeEach(async () => {
    db = await testDatabase({ seedDemo: false });
    const org = await db.createCustomer(
      { name: 'Alpha', slug: 'alpha' },
      { displayName: 'Admin', email: 'admin@alpha.example', team: 'Admin' },
    );
    await db.acceptInvitation(hashToken(org.token), hash);
    admin = { id: org.employeeId, organizationId: org.organizationId, role: 'ADMIN' };
    employees = [];
    for (const name of ['one', 'two']) {
      const invitation = await db.inviteEmployee(admin, {
        displayName: name,
        email: `${name}@alpha.example`,
        team: 'QA',
      });
      await db.acceptInvitation(hashToken(invitation.token), hash);
      employees.push({
        id: invitation.employeeId,
        organizationId: admin.organizationId,
        role: 'EMPLOYEE',
      });
    }
    sessions.clear();
    for (const actor of [admin, ...employees]) await signIn(actor);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });
  const input = (): AdminAgentInput => ({
    requestId: randomUUID(),
    name: 'Release QA',
    employeeIds: employees.map((e) => e.id),
    blueprintId: 'engineering.qa-engineer',
    blueprintVersion: '1.1.0',
    provider: 'test',
    model: 'test-model',
    credentialMode: 'ORGANIZATION_MANAGED',
    answers: {
      projectName: 'Pilot',
      repositoryUrl: 'https://example.com/repo',
      qaUrl: 'https://qa.example.com',
      issueTracker: ['Jira'],
      sourceControl: ['GitHub'],
      testingTechnologies: ['Playwright'],
    },
  });
  // One session per actor, created up front: request helpers stay synchronous supertest chains.
  const sessions = new Map<string, string>();
  const signIn = async (actor: Actor) => {
    const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
    await db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
    sessions.set(actor.id, `af_session=${token}`);
  };
  const cookie = (actor: Actor) => {
    const value = sessions.get(actor.id);
    if (!value) throw new Error(`No test session for ${actor.id}`);
    return value;
  };
  const create = (app: ReturnType<typeof createApp>, body: object, actor = admin) =>
    request(app)
      .post('/api/organization/agents')
      .set('Cookie', cookie(actor))
      .set('Origin', 'http://localhost:4200')
      .send(body);

  it('creates independent signed instances, exposes only owned agents, and preserves runtime approvals', async () => {
    const app = createApp(db, config);
    const result = await create(app, input()).expect(201);
    expect(result.body).toHaveLength(2);
    expect(result.body[0].agentId).not.toBe(result.body[1].agentId);
    for (const employee of employees) {
      const assignment = result.body.find(
        (item: { employeeId: string }) => item.employeeId === employee.id,
      );
      const manifest = await db.getManifest(
        assignment.agentId,
        employee.organizationId,
        employee.id,
      );
      expect(
        await verifyManifest(manifest, db.signer.verificationKey, {
          agentId: assignment.agentId,
          employeeId: employee.id,
          organizationId: employee.organizationId,
        }),
      ).toBe(true);
      // Manifest v1 remains the default issued format (ADR 0004).
      if (manifest.payload.apiVersion !== 'agents-foundry/v1') throw new Error('EXPECTED_V1');
      expect(manifest.payload.capabilities).toContainEqual({
        action: 'qa.execute_playwright',
        outcome: 'REQUIRE_APPROVAL',
      });
      expect(manifest.payload.capabilities).toContainEqual({
        action: 'production.deploy',
        outcome: 'DENY',
      });
      expect((await db.getBootstrap(employee, false)).agents.map((agent) => agent.id)).toEqual([
        assignment.agentId,
      ]);
      const conversation = await request(app)
        .post('/api/conversations')
        .set('Cookie', await cookie(employee))
        .set('Origin', 'http://localhost:4300')
        .send({ employeeId: employee.id, agentId: assignment.agentId, title: 'Private QA work' })
        .expect(201);
      await request(app)
        .get(`/api/conversations/${conversation.body.id}`)
        .set('Cookie', await cookie(employees.find((e) => e.id !== employee.id)!))
        .expect(404);
      const run = await request(app)
        .post('/api/qa/runs')
        .set('Cookie', await cookie(employee))
        .set('Origin', 'http://localhost:4300')
        .send({
          employeeId: employee.id,
          conversationId: conversation.body.id,
          storyKey: 'QA-123',
          targetUrl: 'https://qa.example.com',
        })
        .expect(202);
      expect(run.body.run.status).toBe('AWAITING_APPROVAL');
    }
    expect(await db.listProvisioning(admin.organizationId)).toHaveLength(0);
    const audit = await db.listLifecycleEvents(admin.organizationId);
    expect(audit.filter((event) => event.type === 'agent.assigned')).toHaveLength(2);
    expect(
      audit
        .filter((event) => event.type === 'agent.admin_created')
        .every((event) => event.actorId === admin.id),
    ).toBe(true);
  });

  it('rejects non-admins, missing origins, forged permissions, duplicate recipients and invalid blueprints', async () => {
    const app = createApp(db, config);
    await create(app, input(), employees[0]).expect(403);
    await request(app)
      .get('/api/organization/agents')
      .set('Cookie', await cookie(employees[0]))
      .expect(403);
    await request(app)
      .post('/api/organization/agents')
      .set('Cookie', await cookie(admin))
      .send(input())
      .expect(403);
    for (const body of [
      { ...input(), employeeIds: [] },
      { ...input(), employeeIds: [employees[0].id, employees[0].id] },
      { ...input(), capabilities: [] },
      { ...input(), blueprintVersion: 'invalid' },
      { ...input(), answers: {} },
    ])
      await create(app, body).expect(400);
    expect(await db.listAgentAssignments(admin.organizationId)).toHaveLength(0);
  });

  it('rejects foreign, inactive, pending and admin recipients without partial assignments', async () => {
    const app = createApp(db, config);
    const other = await db.createCustomer(
      { name: 'Other', slug: 'other' },
      { displayName: 'Other', email: 'admin@other.example', team: 'Admin' },
    );
    const pending = await db.inviteEmployee(admin, {
      displayName: 'Pending',
      email: 'pending@alpha.example',
      team: 'QA',
    });
    await db.disableMember(admin, employees[1].id);
    for (const target of [other.employeeId, pending.employeeId, admin.id, employees[1].id])
      await create(app, { ...input(), employeeIds: [employees[0].id, target] }).expect(403);
    expect((await db.getBootstrap(admin, false)).agents).toHaveLength(0);
    expect(await db.listAgentAssignments(admin.organizationId)).toHaveLength(0);
    expect(await db.listAgentAssignments(other.organizationId)).toHaveLength(0);
  });

  it('replays unchanged batches safely and rejects changed reuse of an idempotency key', async () => {
    const app = createApp(db, config),
      body = input();
    const first = await create(app, body).expect(201);
    const replay = await create(app, {
      ...body,
      employeeIds: [...body.employeeIds].reverse(),
    }).expect(201);
    expect(replay.body).toEqual(first.body);
    await create(app, { ...body, name: 'Different agent' }).expect(409);
    expect(await db.listAgentAssignments(admin.organizationId)).toHaveLength(2);
    expect(
      (await db.listLifecycleEvents(admin.organizationId)).filter(
        (event) => event.type === 'agent.assigned',
      ),
    ).toHaveLength(2);
  });

  it('rolls back the whole batch when signing fails after the first instance', async () => {
    const sign = db.signer.sign.bind(db.signer);
    vi.spyOn(db.signer, 'sign')
      .mockImplementationOnce(sign)
      .mockImplementationOnce(() => {
        throw new Error('SIGNING_FAILURE');
      });
    await expect(db.createAssignedAgents(admin, input())).rejects.toThrow('SIGNING_FAILURE');
    expect((await db.getBootstrap(admin, false)).agents).toHaveLength(0);
    expect(await db.listAgentAssignments(admin.organizationId)).toHaveLength(0);
    expect(
      (await db.listLifecycleEvents(admin.organizationId)).some(
        (event) => event.type === 'agent.assigned',
      ),
    ).toBe(false);
  });
});
