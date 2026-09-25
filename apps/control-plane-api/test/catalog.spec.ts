import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Actor,
  AgentBlueprintVersionDefinition,
  CatalogDefinitions,
  OrganizationAgentInstallation,
} from '@agents-foundry/contracts';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { CatalogError, resolveCatalog } from '../src/catalog/catalog-registry.js';
import { compareVersions } from '../src/catalog/catalog-service.js';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { isKnownAction } from '../../../packages/policy-engine/src/index.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { verifyManifest } from '../../employee-desktop/src/app/verify-manifest.js';
import { createDemoApp, demoRequest } from './helpers.js';

const qa = builtInCatalog.blueprints[0]!;
const clone = (): CatalogDefinitions => structuredClone(builtInCatalog);
const withBlueprint = (change: (blueprint: AgentBlueprintVersionDefinition) => void) => {
  const catalog = clone();
  change(catalog.blueprints[0]!);
  return catalog;
};
function problems(catalog: CatalogDefinitions): string {
  try {
    resolveCatalog(catalog, isKnownAction);
    return '';
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    return error.problems.join('\n');
  }
}

describe('catalog validation', () => {
  it('accepts the built-in catalog with a deterministic digest', () => {
    const [first] = resolveCatalog(builtInCatalog, isKnownAction);
    const [second] = resolveCatalog(clone(), isKnownAction);
    expect(first!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second!.digest).toBe(first!.digest);
    expect(first!.content.skills.map((skill) => skill.id)).toEqual(qa.skills.map((s) => s.id));
  });

  it('rejects inconsistent role packages with every problem listed', () => {
    expect(
      problems(withBlueprint((b) => b.skills.push({ id: 'ghost', version: '1.0.0' }))),
    ).toMatch('unknown skill ghost@1.0.0');
    expect(
      problems(withBlueprint((b) => (b.tools = b.tools.filter((tool) => tool.id !== 'browser')))),
    ).toMatch('requires tool browser');
    expect(problems(withBlueprint((b) => b.policy.actions.push('bank.transfer')))).toMatch(
      'policy action bank.transfer is unknown',
    );
    expect(
      problems(withBlueprint((b) => delete b.connectors[0]!.selection.providers['Linear'])),
    ).toMatch('must map every option');
    expect(
      problems(
        withBlueprint((b) => (b.policy.actions = b.policy.actions.filter((a) => a !== 'qa.plan'))),
      ),
    ).toMatch('action qa.plan');
    expect(
      problems(
        withBlueprint(
          (b) => (b.connectors = b.connectors.filter((c) => c.capability !== 'sourceControl')),
        ),
      ),
    ).toMatch('requires connector capability sourceControl.read');
    expect(problems(withBlueprint((b) => (b.mcp[0]!.whenAnswer!.includes = 'Puppeteer')))).toMatch(
      'mcp playwright condition',
    );
    const duplicate = clone();
    duplicate.skills.push(structuredClone(duplicate.skills[0]!));
    expect(problems(duplicate)).toMatch('duplicate version');
    const extra = clone();
    (extra.tools[0] as unknown as Record<string, unknown>)['shell'] = 'rm -rf /';
    expect(problems(extra)).toMatch('tool[0]');
  });

  it('orders versions numerically with pre-releases first', () => {
    expect(['1.10.0', '1.2.0', '1.2.0-rc.1', '0.9.9'].sort(compareVersions)).toEqual([
      '0.9.9',
      '1.2.0-rc.1',
      '1.2.0',
      '1.10.0',
    ]);
  });
});

describe('catalog of record', () => {
  it('pins released versions: a mutated version fails startup, new versions register', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agents-foundry-catalog-'));
    const path = join(directory, 'catalog.db');
    try {
      new ControlPlaneDatabase(path, false).close();
      const mutated = withBlueprint((b) => (b.mission = 'Silently changed mission.'));
      expect(() => new ControlPlaneDatabase(path, false, { catalog: mutated })).toThrow(
        'CATALOG_VERSION_MUTATED: engineering.qa-engineer@1.1.0',
      );
      const next = clone();
      next.blueprints = [{ ...structuredClone(qa), version: '1.2.0', mission: 'Next version.' }];
      const db = new ControlPlaneDatabase(path, false, { catalog: next });
      try {
        // 1.1.0 stopped shipping but stays resolvable from the immutable catalog of record.
        expect(db.catalog.bundle(qa.id, '1.1.0').blueprint.mission).toBe(qa.mission);
        expect(db.catalog.summaries().map((s) => [s.version, s.latest])).toEqual([
          ['1.2.0', true],
          ['1.1.0', false],
        ]);
        expect(db.catalog.legacyBlueprints().map((b) => b.version)).toEqual(['1.2.0']);
        const sql = (db as unknown as { db: DatabaseSync }).db;
        expect(() => sql.prepare("UPDATE catalog_blueprint_versions SET digest='x'").run()).toThrow(
          'CATALOG_VERSION_IMMUTABLE',
        );
        expect(() => sql.prepare('DELETE FROM catalog_blueprint_versions').run()).toThrow(
          'CATALOG_VERSION_IMMUTABLE',
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the legacy /api/blueprints contract and serves versioned bundles', async () => {
    const db = new ControlPlaneDatabase(':memory:');
    try {
      const app = createDemoApp(db);
      const legacy = (await demoRequest(app).get('/api/blueprints').expect(200)).body;
      expect(legacy).toEqual([
        {
          id: 'engineering.qa-engineer',
          version: '1.1.0',
          title: 'QA Engineer',
          department: 'Engineering',
          mission: qa.mission,
          skills: [
            'story-analysis',
            'risk-based-test-planning',
            'regression-analysis',
            'defect-reporting',
          ],
          questionnaire: qa.questionnaire.map(({ scope: _scope, ...question }) => question),
          capabilities: [
            { action: 'repository.read', outcome: 'ALLOW' },
            { action: 'jira.read', outcome: 'ALLOW' },
            { action: 'qa.plan', outcome: 'ALLOW' },
            { action: 'qa.execute_playwright', outcome: 'REQUIRE_APPROVAL' },
            { action: 'jira.issue.create', outcome: 'REQUIRE_APPROVAL' },
            { action: 'repository.pull_request.create', outcome: 'REQUIRE_APPROVAL' },
            { action: 'production.deploy', outcome: 'DENY' },
          ],
        },
      ]);
      const summaries = (await demoRequest(app).get('/api/catalog/v1/blueprints').expect(200)).body;
      expect(summaries).toEqual([expect.objectContaining({ id: qa.id, latest: true })]);
      const bundle = (
        await demoRequest(app).get(`/api/catalog/v1/blueprints/${qa.id}/versions/1.1.0`).expect(200)
      ).body;
      expect(bundle.digest).toBe(summaries[0].digest);
      expect(bundle.workflows.map((w: { id: string }) => w.id)).toEqual(
        qa.workflows.map((w) => w.id),
      );
      await demoRequest(app).get(`/api/catalog/v1/blueprints/${qa.id}/versions/9.9.9`).expect(404);
      await request(app).get('/api/catalog/v1/blueprints').expect(401);
    } finally {
      db.close();
    }
  });
});

describe('organization installations', () => {
  const config: PasswordConfig = {
    mode: 'password',
    adminUrl: 'http://localhost:4200/',
    employeeUrl: 'http://localhost:4300/',
    secureCookies: false,
  };
  const installationConfig = {
    issueTracker: ['Jira'],
    sourceControl: ['Bitbucket'],
    testingTechnologies: ['Playwright'],
  };
  const agentAnswers = {
    projectName: 'Checkout',
    repositoryUrl: 'https://example.com/repo',
    qaUrl: 'https://qa.example.com',
  };
  let hash: string;
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: Actor, employee: Actor, otherAdmin: Actor;
  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });
  beforeEach(() => {
    db = new ControlPlaneDatabase(':memory:', false, { manifestV2Issuance: true });
    app = createApp(db, config);
    const tenant = (name: string) => {
      const org = db.createCustomer(
        { name, slug: name.toLowerCase() },
        { displayName: 'Admin', email: `admin@${name}.example`, team: 'Admin' },
      );
      db.acceptInvitation(hashToken(org.token), hash);
      return { id: org.employeeId, organizationId: org.organizationId, role: 'ADMIN' as const };
    };
    admin = tenant('Alpha');
    otherAdmin = tenant('Beta');
    const invitation = db.inviteEmployee(admin, {
      displayName: 'Quinn',
      email: 'quinn@alpha.example',
      team: 'QA',
    });
    db.acceptInvitation(hashToken(invitation.token), hash);
    employee = {
      id: invitation.employeeId,
      organizationId: admin.organizationId,
      role: 'EMPLOYEE',
    };
  });
  afterEach(() => db.close());

  const cookie = (actor: Actor) => {
    const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
    db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
    return `af_session=${token}`;
  };
  const call = (method: 'get' | 'post' | 'put', path: string, actor: Actor, body?: object) => {
    const pending = request(app)
      [method](path)
      .set('Cookie', cookie(actor))
      .set('Origin', 'http://localhost:4200');
    return body ? pending.send(body) : pending;
  };
  const install = async (actor = admin, name = 'Checkout QA') =>
    (
      await call('post', '/api/organization/agent-installations', actor, {
        name,
        blueprintId: qa.id,
        blueprintVersion: '1.1.0',
        configuration: installationConfig,
      }).expect(201)
    ).body as OrganizationAgentInstallation;
  const createAgent = (
    installation: OrganizationAgentInstallation,
    answers: object = agentAnswers,
    requestId = randomUUID(),
  ) =>
    call('post', '/api/organization/agents', admin, {
      requestId,
      installationId: installation.id,
      name: 'Checkout QA agent',
      employeeIds: [employee.id],
      blueprintId: installation.blueprintId,
      blueprintVersion: installation.blueprintVersion,
      provider: 'test',
      model: 'test-model',
      credentialMode: 'ORGANIZATION_MANAGED',
      answers,
    });

  it('installs a blueprint version with validated organization-level configuration', async () => {
    const installation = await install();
    expect(installation).toMatchObject({
      organizationId: admin.organizationId,
      status: 'ACTIVE',
      version: 1,
      configuration: installationConfig,
    });
    expect(installation.blueprintDigest).toBe(db.catalog.bundle(qa.id, '1.1.0').digest);
    const base = { name: 'Other', blueprintId: qa.id, blueprintVersion: '1.1.0' };
    for (const body of [
      { ...base, configuration: { ...installationConfig, qaUrl: 'https://qa.example.com' } },
      { ...base, configuration: { ...installationConfig, issueTracker: ['Unknown'] } },
      { ...base, configuration: {} },
      { ...base, blueprintVersion: '9.9.9', configuration: installationConfig },
      { ...base, organizationId: otherAdmin.organizationId, configuration: installationConfig },
    ])
      await call('post', '/api/organization/agent-installations', admin, body).expect(400);
    await call('post', '/api/organization/agent-installations', admin, {
      ...base,
      name: 'checkout qa',
      configuration: installationConfig,
    }).expect(409);
    await call('get', '/api/organization/agent-installations', employee).expect(403);
    const listed = (await call('get', '/api/organization/agent-installations', admin).expect(200))
      .body;
    expect(listed.map((item: OrganizationAgentInstallation) => item.id)).toEqual([installation.id]);
    const sql = (db as unknown as { db: DatabaseSync }).db;
    expect(
      sql
        .prepare(
          "SELECT action FROM organization_change_events WHERE resource_type='agent_installation'",
        )
        .all()
        .map((row) => row['action']),
    ).toEqual(['agent_installation.created']);
  });

  it('creates agents that inherit installation configuration into signed v2 manifests', async () => {
    const installation = await install();
    const [assignment] = (await createAgent(installation).expect(201)).body;
    const manifest = db.getManifest(assignment.agentId, admin.organizationId, employee.id);
    if (manifest.payload.apiVersion !== 'agents-foundry/v2') throw new Error('EXPECTED_V2');
    expect(manifest.payload.metadata).toMatchObject({
      installationId: installation.id,
      blueprint: { id: qa.id, version: '1.1.0', digest: installation.blueprintDigest },
    });
    expect(manifest.payload.configuration).toEqual({ ...installationConfig, ...agentAnswers });
    expect(manifest.payload.connectors.map((c) => c.id)).toEqual(['jira', 'bitbucket']);
    expect(manifest.payload.mcp).toEqual(['playwright']);
    expect(manifest.payload.identity).toEqual({
      name: 'Checkout QA agent',
      role: 'qa-engineer',
      department: 'Engineering',
    });
    expect(
      await verifyManifest(manifest, db.signer.verificationKey, {
        agentId: assignment.agentId,
        employeeId: employee.id,
        organizationId: admin.organizationId,
      }),
    ).toBe(true);
    // Installation-scoped answers are owned by the installation and cannot be overridden.
    await createAgent(installation, { ...agentAnswers, issueTracker: ['Linear'] }).expect(400);
    await createAgent(installation, { projectName: 'Missing URLs' }).expect(400);
  });

  it('applies installation changes to future agents only and blocks retired installations', async () => {
    const installation = await install();
    const firstRequest = randomUUID();
    const [first] = (await createAgent(installation, agentAnswers, firstRequest).expect(201)).body;
    const before = db.getManifest(first.agentId, admin.organizationId);
    await call('put', `/api/organization/agent-installations/${installation.id}`, admin, {
      name: installation.name,
      blueprintVersion: '1.1.0',
      configuration: { ...installationConfig, issueTracker: ['Linear'] },
      version: 99,
    }).expect(409);
    const updated = (
      await call('put', `/api/organization/agent-installations/${installation.id}`, admin, {
        name: installation.name,
        blueprintVersion: '1.1.0',
        configuration: { ...installationConfig, issueTracker: ['Linear'] },
        version: 1,
      }).expect(200)
    ).body as OrganizationAgentInstallation;
    expect(updated.version).toBe(2);
    const [second] = (await createAgent(updated).expect(201)).body;
    const secondManifest = db.getManifest(second.agentId, admin.organizationId);
    if (secondManifest.payload.apiVersion !== 'agents-foundry/v2') throw new Error('EXPECTED_V2');
    expect(secondManifest.payload.connectors.map((c) => c.id)).toEqual(['linear', 'bitbucket']);
    expect(db.getManifest(first.agentId, admin.organizationId)).toEqual(before);

    await call('post', `/api/organization/agent-installations/${installation.id}/retire`, admin, {
      version: 2,
    }).expect(200);
    await createAgent(updated).expect(409);
    // An unchanged retry of a completed request still replays its original result.
    const replay = (await createAgent(installation, agentAnswers, firstRequest).expect(201)).body;
    expect(replay[0].agentId).toBe(first.agentId);
    expect(db.getManifest(first.agentId, admin.organizationId)).toEqual(before);
    await call('put', `/api/organization/agent-installations/${installation.id}`, admin, {
      name: 'Revived',
      blueprintVersion: '1.1.0',
      configuration: installationConfig,
      version: 3,
    }).expect(409);
    expect(
      (await call('get', '/api/organization/agent-installations?status=all', admin).expect(200))
        .body[0].status,
    ).toBe('RETIRED');
  });

  it('isolates installations by tenant', async () => {
    const installation = await install();
    await call('put', `/api/organization/agent-installations/${installation.id}`, otherAdmin, {
      name: 'Stolen',
      blueprintVersion: '1.1.0',
      configuration: installationConfig,
      version: 1,
    }).expect(404);
    await call(
      'post',
      `/api/organization/agent-installations/${installation.id}/retire`,
      otherAdmin,
      {
        version: 1,
      },
    ).expect(404);
    expect(
      (await call('get', '/api/organization/agent-installations', otherAdmin).expect(200)).body,
    ).toEqual([]);
    const sql = (db as unknown as { db: DatabaseSync }).db;
    expect(() =>
      sql
        .prepare(
          "INSERT INTO agents (id, organization_id, name, department, team, status, capabilities, installation_id) VALUES (?,?,?,?,?,'ACTIVE','[]',?)",
        )
        .run(randomUUID(), otherAdmin.organizationId, 'x', 'x', 'x', installation.id),
    ).toThrow('INSTALLATION_SCOPE_MISMATCH');
  });

  it('rejects an installation for a different blueprint version than requested', async () => {
    const installation = await install();
    await createAgent({ ...installation, blueprintVersion: '1.2.0' }).expect(400);
  });
});

describe('second role through configuration only (ADR 0009)', () => {
  it('resolves a new blueprint into a signed manifest without platform code changes', () => {
    const catalog = clone();
    catalog.tools.push({
      id: 'code-editor',
      version: '1.0.0',
      description: 'Edit source files inside an isolated workspace.',
      risk: 'MEDIUM',
      executionLocation: 'EXECUTION_RUNTIME',
      sideEffects: 'LOCAL_WRITE',
      governedActions: [],
      timeoutMs: 60_000,
    });
    catalog.skills.push({
      id: 'frontend-implementation',
      version: '1.0.0',
      title: 'Frontend implementation',
      description: 'Implement UI changes that follow the repository architecture.',
      requires: {
        tools: ['code-editor', 'repository'],
        connectorCapabilities: ['sourceControl.read'],
      },
      activatesWhen: { workflows: ['implement-story'] },
    });
    catalog.workflows.push({
      id: 'implement-story',
      version: '1.0.0',
      title: 'Implement story',
      description: 'Implement, verify and propose a change.',
      steps: [
        { id: 'implement', title: 'Implement', skill: 'frontend-implementation' },
        {
          id: 'propose',
          title: 'Open pull request',
          skill: 'frontend-implementation',
          action: 'repository.pull_request.create',
        },
      ],
    });
    catalog.blueprints.push({
      ...structuredClone(qa),
      id: 'engineering.frontend-engineer',
      version: '0.1.0',
      title: 'Frontend Engineer',
      role: 'frontend-engineer',
      mission: 'Implement approved frontend changes and propose them for review.',
      persona: { profile: 'frontend-engineer-default' },
      model: { profile: 'frontend-default' },
      skills: [{ id: 'frontend-implementation', version: '1.0.0' }],
      tools: [
        { id: 'code-editor', version: '1.0.0' },
        { id: 'repository', version: '1.0.0' },
      ],
      workflows: [{ id: 'implement-story', version: '1.0.0' }],
      connectors: [qa.connectors[1]!],
      mcp: [],
      policy: {
        profile: 'frontend-standard',
        actions: ['repository.read', 'repository.pull_request.create', 'production.deploy'],
      },
      evaluations: { suite: 'frontend-engineer-v0' },
      questionnaire: [
        { id: 'projectName', label: 'Project name', type: 'text', required: true, scope: 'AGENT' },
        qa.questionnaire.find((q) => q.id === 'sourceControl')!,
      ],
    });
    const db = new ControlPlaneDatabase(':memory:', true, { manifestV2Issuance: true, catalog });
    try {
      const pending = db.requestProvisioning('employee_qa_demo', {
        blueprintId: 'engineering.frontend-engineer',
        blueprintVersion: '0.1.0',
        provider: 'test',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: { projectName: 'Storefront', sourceControl: ['GitHub'] },
      });
      const { manifest } = db.decideProvisioning(
        pending.id,
        'org_agents_foundry',
        'admin_demo',
        'APPROVED',
        'ok',
      );
      if (manifest?.payload.apiVersion !== 'agents-foundry/v2') throw new Error('EXPECTED_V2');
      expect(manifest.payload).toMatchObject({
        identity: { role: 'frontend-engineer', name: 'Frontend Engineer · Storefront' },
        skills: [{ id: 'frontend-implementation', version: '1.0.0' }],
        tools: ['code-editor', 'repository'],
        workflows: ['implement-story'],
        connectors: [{ id: 'github', capabilities: ['sourceControl.read'] }],
        mcp: [],
      });
      expect(manifest.payload.policies.capabilities).toEqual([
        { action: 'repository.read', outcome: 'ALLOW' },
        { action: 'repository.pull_request.create', outcome: 'REQUIRE_APPROVAL' },
        { action: 'production.deploy', outcome: 'DENY' },
      ]);
      const agentId = manifestSubject(manifest.payload).agentId;
      expect(db.getManifest(agentId, 'org_agents_foundry')).toEqual(manifest);
      // The QA role is unaffected by the second role's presence.
      expect(
        db.catalog
          .legacyBlueprints()
          .map((b) => b.id)
          .sort(),
      ).toEqual(['engineering.frontend-engineer', 'engineering.qa-engineer']);
    } finally {
      db.close();
    }
  });
});
