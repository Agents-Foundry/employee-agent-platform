import {
  createHash,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, SignedExecutionGrant } from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { MemorySecretStore } from '../src/actions/secrets.js';
import { GitHubAppIssuer, StaticTokenIssuer } from '../src/credentials/credential-issuers.js';
import { repositoryOf } from '../src/credentials/source-control.js';
import {
  SecretBroker,
  SecretUnavailable,
  SecretValue,
  VaultSecretProvider,
} from '../src/secrets/secret-broker.js';
import { canonicalManifest, manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { runtimeKeyPair, signedRuntimePost } from './runtime-helpers.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const org = 'org_agents_foundry';
const employeeId = 'employee_qa_demo';
const admin: Actor = { id: 'admin_demo', role: 'ADMIN', organizationId: org };
const agentRuntime = runtimeKeyPair();
const executionRuntime = runtimeKeyPair();
const otherExecution = runtimeKeyPair();
const foreignExecution = runtimeKeyPair();
const TOKEN = `github_pat_${randomBytes(24).toString('hex')}`;
const REPOSITORY_URL = 'https://github.com/acme/private';
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalManifest(value)).digest('hex');

describe('secret broker', () => {
  it('never prints, serializes or inspects a secret value', () => {
    const secret = new SecretValue(TOKEN);
    expect(secret.reveal()).toBe(TOKEN);
    for (const rendered of [
      String(secret),
      `${secret}`,
      JSON.stringify({ secret }),
      inspect(secret),
      inspect({ nested: { secret } }, { depth: 5 }),
    ])
      expect(rendered).not.toContain(TOKEN);
    expect(Object.keys(secret)).toEqual([]);
    expect(() => new SecretValue('')).toThrow('SECRET_EMPTY');
  });

  it('resolves per organization and fails closed', async () => {
    const store = new MemorySecretStore();
    store.set('org-a', 'git-read', TOKEN);
    const lookups: string[] = [];
    const broker = new SecretBroker({
      id: 'test',
      resolve: async (organizationId, name) => {
        lookups.push(`${organizationId}/${name}`);
        if (name === 'broken') throw new Error(`vault said: ${TOKEN}`);
        return store.resolve(organizationId, `secret://${name}`);
      },
    });
    expect((await broker.resolve('org-a', 'secret://git-read')).reveal()).toBe(TOKEN);
    // Another organization's secret of the same name does not exist for this one.
    await expect(broker.resolve('org-b', 'secret://git-read')).rejects.toMatchObject({
      code: 'SECRET_UNRESOLVED',
    });
    // Provider failures carry nothing from the provider.
    const failure = await broker.resolve('org-a', 'secret://broken').catch((error) => error);
    expect(failure).toBeInstanceOf(SecretUnavailable);
    expect(String(failure) + JSON.stringify(failure)).not.toContain(TOKEN);
    // Anything that is not a reference never reaches the provider.
    for (const reference of ['git-read', 'secret://', 'secret://../x', TOKEN, 'vault://x'])
      await expect(broker.resolve('org-a', reference)).rejects.toMatchObject({
        code: 'SECRET_REFERENCE_INVALID',
      });
    await expect(broker.resolve('', 'secret://git-read')).rejects.toBeInstanceOf(SecretUnavailable);
    expect(lookups).toEqual(['org-a/git-read', 'org-b/git-read', 'org-a/broken']);
  });

  it('reads Vault KV v2 under the organization path and trusts nothing else', async () => {
    const calls: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
    const replies: Response[] = [
      Response.json({ data: { data: { value: TOKEN } } }),
      new Response('', { status: 404 }),
      new Response(`permission denied for ${TOKEN}`, { status: 403 }),
      Response.json({ data: { data: { other: 'x' } } }),
    ];
    const provider = new VaultSecretProvider({
      address: 'https://vault.internal:8200',
      mount: 'agents-foundry',
      prefix: 'prod',
      namespace: 'platform',
      token: () => 'vault-token',
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push({
          url: String(url),
          headers: init.headers as Record<string, string>,
          redirect: init.redirect as string,
        });
        return replies.shift()!;
      }) as unknown as typeof fetch,
    });
    const broker = new SecretBroker(provider);
    expect(broker.providerId).toBe('vault');
    expect((await broker.resolve('org-a', 'secret://git-read')).reveal()).toBe(TOKEN);
    expect(calls[0]).toEqual({
      url: 'https://vault.internal:8200/v1/agents-foundry/data/prod/org-a/git-read',
      headers: { 'X-Vault-Token': 'vault-token', 'X-Vault-Namespace': 'platform' },
      redirect: 'error',
    });
    for (let i = 0; i < 3; i++) {
      const failure = await broker.resolve('org-a', 'secret://git-read').catch((error) => error);
      expect(failure).toMatchObject({ code: 'SECRET_UNRESOLVED' });
      expect(String(failure)).not.toContain(TOKEN);
    }
    // An organization id cannot climb out of its own path.
    await expect(broker.resolve('../org-b', 'secret://git-read')).rejects.toMatchObject({
      code: 'SECRET_UNRESOLVED',
    });
    expect(calls).toHaveLength(4);
    expect(
      () => new VaultSecretProvider({ address: 'http://vault', mount: 'm', token: () => '' }),
    ).toThrow('VAULT_ADDRESS_INVALID');
  });
});

describe('repository names', () => {
  it('accepts only a plain HTTPS repository URL on the connection host', () => {
    expect(repositoryOf('https://github.com/acme/private', 'github.com')).toBe('acme/private');
    expect(repositoryOf('https://GitHub.com/acme/private.git', 'github.com')).toBe('acme/private');
    for (const url of [
      'http://github.com/acme/private',
      'https://github.com.evil.test/acme/private',
      'https://token@github.com/acme/private',
      'https://github.com:8443/acme/private',
      'https://github.com/acme/private/extra',
      'https://github.com/acme',
      'https://github.com/acme/private?ref=x',
      'https://github.com/acme/../other/private',
      'not a url',
    ])
      expect(repositoryOf(url, 'github.com'), url).toBeNull();
  });
});

describe('credential broker', () => {
  let db: ControlPlaneDatabase;
  let app: ReturnType<typeof createApp>;
  let agentId: string;
  let secrets: MemorySecretStore;
  let clock: number | undefined;
  let githubApp: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    secrets = new MemorySecretStore();
    secrets.set(org, 'git-read', TOKEN);
    clock = undefined;
    githubApp = vi.fn();
    db = await testDatabase({
      manifestV2Issuance: true,
      genericRuntime: true,
      secrets,
      allowPrivateConnectorUrls: true,
      credentialBroker: {
        now: () => clock ?? Date.now(),
        issuers: [
          new StaticTokenIssuer(),
          new GitHubAppIssuer({ fetch: githubApp as unknown as typeof fetch }),
        ],
      },
      runtimeIdentities: [
        {
          id: 'runtime-g',
          publicKeySpki: agentRuntime.spki,
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
        {
          id: 'exec-1',
          publicKeySpki: executionRuntime.spki,
          organizations: [org],
          runtimeProfiles: ['execution'],
          role: 'execution',
        },
        {
          id: 'exec-2',
          publicKeySpki: otherExecution.spki,
          organizations: [org],
          runtimeProfiles: ['execution'],
          role: 'execution',
        },
        {
          id: 'exec-foreign',
          publicKeySpki: foreignExecution.spki,
          organizations: ['org_other'],
          runtimeProfiles: ['execution'],
          role: 'execution',
        },
      ],
    });
    // The demo administrator has no membership row; stand in for the real role check.
    db.structure.authorize = (async (actor: Actor) => {
      if (actor.role !== 'ADMIN' || actor.organizationId !== org)
        throw new Error('ORGANIZATION_ADMIN_REQUIRED');
    }) as never;
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
          repositoryUrl: REPOSITORY_URL,
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

  const connect = (overrides: Record<string, unknown> = {}) =>
    db.sourceControl.create(admin, {
      provider: 'github',
      name: 'GitHub read access',
      gitHost: 'github.com',
      apiBaseUrl: 'https://api.github.com',
      credentialMode: 'static_token',
      secretRef: 'secret://git-read',
      allowedRepositories: ['acme/private'],
      ...overrides,
    });
  const agentPost = (path: string, body?: unknown) =>
    signedRuntimePost(app, 'runtime-g', agentRuntime.privateKey, path, body);
  const execPost = (path: string, body?: unknown, id = 'exec-1', key = executionRuntime) =>
    signedRuntimePost(app, id, key.privateKey, path, body);
  const redeem = (grant: unknown, leaseId: string, id?: string, key?: typeof executionRuntime) =>
    execPost('/runtime/v1/credentials/redeem', { leaseId, grant }, id, key);
  const release = (
    leaseId: string,
    grantId: string,
    outcome = 'SUCCEEDED',
    id?: string,
    key?: typeof executionRuntime,
  ) => execPost('/runtime/v1/credentials/release', { leaseId, grantId, outcome }, id, key);
  const lease = async (id: string) =>
    (await rawSql(db)
      .prepare('SELECT * FROM repository_credential_leases WHERE id=?')
      .get<Record<string, string | null>>(id))!;

  /** A running run, and a way to get the signed grant for one operation. */
  const running = async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'x', inputs: {} } })
        .expect(202)
    ).body as { id: string; threadId: string };
    const claim = (await agentPost('/runtime/v1/commands/claim').expect(200)).body;
    const correlation = {
      organizationId: org,
      employeeId,
      agentId,
      threadId: run.threadId,
      runId: run.id,
    };
    let sequence = 0;
    const emit = (type: string, payload: object, stepId?: string) =>
      agentPost('/runtime/v1/events', {
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
    const grantFor = async (operation: object): Promise<SignedExecutionGrant> => {
      const decision = (
        await agentPost('/runtime/v1/actions', {
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
      expect(decision.decision).toBe('ALLOWED');
      return (
        await agentPost('/runtime/v1/actions/grant', {
          protocol: 'agents-foundry/runtime/v1',
          requestId: decision.requestId,
          correlation: full,
        }).expect(200)
      ).body;
    };
    return { run, grantFor, full };
  };
  const checkout = {
    kind: 'git.checkout',
    repositoryUrl: REPOSITORY_URL,
    ref: 'main',
    path: 'repo',
  };
  const issued = async () => {
    const context = await running();
    const grant = await context.grantFor(checkout);
    return { ...context, grant, leaseId: grant.payload.credential!.leaseId };
  };

  it('checks out anonymously when no connection authenticates the repository', async () => {
    const { grantFor } = await running();
    expect((await grantFor(checkout)).payload.credential).toBeUndefined();
    // A connection for the host that does not allow this repository changes nothing.
    await connect({ allowedRepositories: ['acme/other'] });
    const { grantFor: again } = await running();
    expect((await again({ ...checkout, path: 'second' })).payload.credential).toBeUndefined();
    expect(
      await rawSql(db).prepare('SELECT count(*)::int AS n FROM repository_credential_leases').get(),
    ).toEqual({ n: 0 });
  });

  it('issues one short-lived lease bound to the signed grant, and never a secret', async () => {
    const connection = await connect();
    const { grant, leaseId, run, grantFor } = await issued();
    expect(grant.payload.credential).toEqual({
      leaseId,
      provider: 'github',
      gitHost: 'github.com',
    });
    expect(JSON.stringify(grant)).not.toContain(TOKEN);
    const row = await lease(leaseId);
    expect(row).toMatchObject({
      organization_id: org,
      connection_id: connection.id,
      provider: 'github',
      repository: 'acme/private',
      repository_url: REPOSITORY_URL,
      ref: 'main',
      operation_kind: 'git.checkout',
      operation_digest: grant.payload.operationDigest,
      grant_id: grant.payload.grantId,
      request_id: grant.payload.requestId,
      run_id: run.id,
      employee_id: employeeId,
      agent_id: agentId,
      issued_to_runtime: 'runtime-g',
      status: 'ISSUED',
    });
    // Five minutes, and never beyond the grant.
    expect(Date.parse(row['expires_at']!) - Date.parse(row['issued_at']!)).toBe(300_000);
    expect(Date.parse(row['expires_at']!)).toBeLessThanOrEqual(Date.parse(grant.payload.expiresAt));
    // Redelivering the grant redelivers the same lease; another operation gets its own.
    expect((await grantFor(checkout)).payload.grantId).not.toBe(grant.payload.grantId);
    expect(
      await rawSql(db).prepare('SELECT count(*)::int AS n FROM repository_credential_leases').get(),
    ).toEqual({ n: 2 });
    const audit = await rawSql(db)
      .prepare(
        "SELECT metadata FROM audit_events WHERE event_type='credential.lease.issued' ORDER BY created_at",
      )
      .all<{ metadata: string }>();
    expect(JSON.parse(audit[0]!.metadata)).toMatchObject({
      leaseId,
      repository: 'acme/private',
      ref: 'main',
    });
  });

  it('gives the credential once, to an execution runtime holding the exact grant', async () => {
    await connect();
    const { grant, leaseId } = await issued();
    // An agent runtime can never redeem, even with the grant it was given.
    await agentPost('/runtime/v1/credentials/redeem', { leaseId, grant }).expect(403, {
      error: 'RUNTIME_ROLE_FORBIDDEN',
    });
    // An execution runtime cannot act as an agent runtime either.
    await execPost('/runtime/v1/commands/claim').expect(403, { error: 'RUNTIME_ROLE_FORBIDDEN' });
    expect((await lease(leaseId))['status']).toBe('ISSUED');

    const redeemed = (await redeem(grant, leaseId).expect(200)).body;
    expect(redeemed).toEqual({
      leaseId,
      credential: { scheme: 'basic', username: 'x-access-token', password: TOKEN },
      expiresAt: (await lease(leaseId))['expires_at'],
    });
    expect(await lease(leaseId)).toMatchObject({ status: 'REDEEMED', redeemed_by: 'exec-1' });

    // Replay, by the same or another runtime: refused, and the lease is revoked.
    await redeem(grant, leaseId).expect(409, { error: 'CREDENTIAL_LEASE_ALREADY_USED' });
    expect(await lease(leaseId)).toMatchObject({
      status: 'REVOKED',
      revoke_reason: 'CREDENTIAL_LEASE_ALREADY_USED',
    });
    await redeem(grant, leaseId, 'exec-2', otherExecution).expect(409, {
      error: 'CREDENTIAL_LEASE_REVOKED',
    });
  });

  it('refuses another tenant, another grant, another operation and a forged grant', async () => {
    await connect();
    const { grant, leaseId, grantFor } = await issued();
    // An execution runtime that does not serve this organization.
    await redeem(grant, leaseId, 'exec-foreign', foreignExecution).expect(403, {
      error: 'CREDENTIAL_ORGANIZATION_FORBIDDEN',
    });
    // Another checkout's grant cannot redeem this lease, nor can a grant for another operation.
    const second = await grantFor({ ...checkout, ref: 'release', path: 'other' });
    await redeem(second, leaseId).expect(403, { error: 'CREDENTIAL_LEASE_MISMATCH' });
    const status = await grantFor({ kind: 'git.status', path: 'repo' });
    expect(status.payload.credential).toBeUndefined();
    await redeem(status, leaseId).expect(403, { error: 'CREDENTIAL_LEASE_MISMATCH' });
    // A grant edited to name this lease, or to point somewhere else, no longer verifies.
    for (const forged of [
      { ...status, payload: { ...status.payload, credential: grant.payload.credential } },
      { ...grant, payload: { ...grant.payload, operationDigest: digest({ other: true }) } },
      {
        ...grant,
        payload: {
          ...grant.payload,
          correlation: { ...grant.payload.correlation, organizationId: 'org_other' },
        },
      },
      { ...grant, signature: second.signature },
    ])
      await redeem(forged, leaseId).expect(403, { error: 'CREDENTIAL_GRANT_INVALID' });
    await redeem({ nonsense: true }, leaseId).expect(403, { error: 'CREDENTIAL_GRANT_INVALID' });
    await redeem(grant, randomUUID()).expect(403, { error: 'CREDENTIAL_LEASE_MISMATCH' });
    // None of that used up or revoked the lease: its rightful holder still redeems it.
    expect((await lease(leaseId))['status']).toBe('ISSUED');
    await redeem(grant, leaseId).expect(200);
  });

  it('refuses expired and revoked leases', async () => {
    await connect();
    const first = await issued();
    clock = Date.now() + 300_001;
    await redeem(first.grant, first.leaseId).expect(409, { error: 'CREDENTIAL_LEASE_EXPIRED' });
    expect((await lease(first.leaseId))['status']).toBe('EXPIRED');
    clock = undefined;

    const second = await first.grantFor({ ...checkout, path: 'two' });
    const secondLease = second.payload.credential!.leaseId;
    const employee: Actor = { id: employeeId, role: 'EMPLOYEE', organizationId: org };
    await expect(db.credentials.revoke(employee, secondLease)).rejects.toThrow();
    await expect(
      db.credentials.revoke({ ...admin, organizationId: 'org_other' }, secondLease),
    ).rejects.toThrow();
    expect(await db.credentials.revoke(admin, secondLease)).toMatchObject({
      id: secondLease,
      status: 'REVOKED',
      revokeReason: 'REVOKED_BY_ADMINISTRATOR',
    });
    await redeem(second, secondLease).expect(409, { error: 'CREDENTIAL_LEASE_REVOKED' });
    await expect(db.credentials.revoke(admin, secondLease)).rejects.toMatchObject({
      message: 'CREDENTIAL_LEASE_NOT_LIVE',
    });

    // The sweep expires live leases past their deadline, redeemed or not.
    const third = await first.grantFor({ ...checkout, path: 'three' });
    const fourth = await first.grantFor({ ...checkout, path: 'four' });
    await redeem(fourth, fourth.payload.credential!.leaseId).expect(200);
    clock = Date.now() + 300_001;
    expect(await db.credentials.expireDue()).toBe(2);
    expect((await lease(third.payload.credential!.leaseId))['status']).toBe('EXPIRED');
    expect((await lease(fourth.payload.credential!.leaseId))['status']).toBe('EXPIRED');
    expect((await db.credentials.list(admin)).map((item) => item.status).sort()).toEqual([
      'EXPIRED',
      'EXPIRED',
      'EXPIRED',
      'REVOKED',
    ]);
  });

  it('refuses when the run stopped, the connection was disabled or the secret is missing', async () => {
    const connection = await connect();
    const cancelled = await issued();
    const cancel = await demoRequest(app).post(`/api/execution/v1/runs/${cancelled.run.id}/cancel`);
    expect(cancel.status).toBeLessThan(300);
    // Stopping the run revokes its leases in the same transaction.
    expect(await lease(cancelled.leaseId)).toMatchObject({
      status: 'REVOKED',
      revoke_reason: 'RUN_CANCELLED',
      revoked_by: 'platform',
    });
    await redeem(cancelled.grant, cancelled.leaseId).expect(409, {
      error: 'CREDENTIAL_LEASE_REVOKED',
    });
    // The runtime collects the cancellation before it is offered another run.
    await agentPost('/runtime/v1/commands/claim').expect(200);

    const unresolved = await issued();
    secrets.set(org, 'git-read', '');
    const failed = await redeem(unresolved.grant, unresolved.leaseId).expect(502);
    expect(failed.body).toEqual({ error: 'CREDENTIAL_UNAVAILABLE' });
    expect(await lease(unresolved.leaseId)).toMatchObject({
      status: 'REVOKED',
      revoke_reason: 'SECRET_UNRESOLVED',
    });
    secrets.set(org, 'git-read', TOKEN);

    const disabled = await unresolved.grantFor({ ...checkout, path: 'later' });
    await db.sourceControl.disable(admin, connection.id, connection.version);
    await redeem(disabled, disabled.payload.credential!.leaseId).expect(409, {
      error: 'CREDENTIAL_CONNECTION_INACTIVE',
    });
    // With the connection disabled, new checkouts are anonymous again.
    expect(
      (await unresolved.grantFor({ ...checkout, path: 'anonymous' })).payload.credential,
    ).toBeUndefined();
  });

  it('lets only the redeeming runtime release a lease', async () => {
    await connect();
    const { grant, leaseId } = await issued();
    const grantId = grant.payload.grantId;
    // Not yet redeemed: there is nothing to release.
    await release(leaseId, grantId).expect(404, { error: 'CREDENTIAL_LEASE_UNKNOWN' });
    await redeem(grant, leaseId).expect(200);
    await release(leaseId, grantId, 'SUCCEEDED', 'exec-2', otherExecution).expect(404);
    await release(leaseId, grantId, 'SUCCEEDED', 'exec-foreign', foreignExecution).expect(404);
    await release(leaseId, randomUUID()).expect(404);
    await agentPost('/runtime/v1/credentials/release', {
      leaseId,
      grantId,
      outcome: 'SUCCEEDED',
    }).expect(403);
    await release(leaseId, grantId, 'TIMED_OUT').expect(200, { leaseId, status: 'RELEASED' });
    expect(await lease(leaseId)).toMatchObject({ status: 'RELEASED', outcome: 'TIMED_OUT' });
    // Idempotent, and a released lease cannot be redeemed again.
    await release(leaseId, grantId).expect(200, { leaseId, status: 'RELEASED' });
    await redeem(grant, leaseId).expect(409, { error: 'CREDENTIAL_LEASE_ALREADY_USED' });
    expect((await lease(leaseId))['status']).toBe('RELEASED');
  });

  it('keeps leases immutable and forward-only in the database', async () => {
    await connect();
    const { grant, leaseId } = await issued();
    const sql = rawSql(db);
    await expect(
      sql
        .prepare("UPDATE repository_credential_leases SET repository='acme/other' WHERE id=?")
        .run(leaseId),
    ).rejects.toThrow('CREDENTIAL_LEASE_IMMUTABLE');
    await expect(
      sql
        .prepare(
          "UPDATE repository_credential_leases SET expires_at=expires_at + interval '1 day' WHERE id=?",
        )
        .run(leaseId),
    ).rejects.toThrow('CREDENTIAL_LEASE_IMMUTABLE');
    await expect(
      sql
        .prepare("UPDATE repository_credential_leases SET status='RELEASED' WHERE id=?")
        .run(leaseId),
    ).rejects.toThrow('CREDENTIAL_LEASE_TRANSITION_INVALID');
    await redeem(grant, leaseId).expect(200);
    await expect(
      sql
        .prepare(
          "UPDATE repository_credential_leases SET status='ISSUED', redeemed_at=NULL, redeemed_by=NULL WHERE id=?",
        )
        .run(leaseId),
    ).rejects.toThrow('CREDENTIAL_LEASE_TRANSITION_INVALID');
    await expect(sql.prepare('DELETE FROM repository_credential_leases').run()).rejects.toThrow(
      'CREDENTIAL_LEASE_IMMUTABLE',
    );
    await expect(
      sql
        .prepare("UPDATE organization_source_control_connections SET secret_ref='secret://other'")
        .run(),
    ).rejects.toThrow('SOURCE_CONTROL_CONNECTION_IMMUTABLE');
    await expect(
      sql.prepare('DELETE FROM organization_source_control_connections').run(),
    ).rejects.toThrow('SOURCE_CONTROL_CONNECTION_IMMUTABLE');
  });

  it('forces row-level security on both credential tables', async () => {
    await connect();
    const { leaseId } = await issued();
    const tables = ['organization_source_control_connections', 'repository_credential_leases'];
    const secured = await rawSql(db)
      .prepare(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename=c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname = ANY(?::text[]) ORDER BY c.relname`,
      )
      .all(`{${tables.join(',')}}`);
    expect(secured).toEqual(
      tables.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 1,
      })),
    );
    for (const table of tables) {
      // Its own tenant sees its rows; any other tenant, and no tenant at all, sees none.
      expect(
        await db.store.tenant(org, () => db.store.all(`SELECT id FROM ${table}`)),
        table,
      ).toHaveLength(1);
      expect(
        await db.store.tenant('org_other', () => db.store.all(`SELECT id FROM ${table}`)),
        table,
      ).toEqual([]);
      // Another tenant can neither change nor claim the rows.
      expect(
        await db.store.tenant('org_other', () => db.store.run(`UPDATE ${table} SET status=status`)),
        table,
      ).toEqual({ changes: 0 });
    }
    await expect(
      db.store.tenant('org_other', () =>
        db.store.run(
          `INSERT INTO repository_credential_leases (id,organization_id,connection_id,provider,repository,
           repository_url,ref,operation_kind,operation_digest,grant_id,request_id,run_id,employee_id,agent_id,
           issued_to_runtime,status,issued_at,expires_at)
           SELECT ?, organization_id, connection_id, provider, repository, repository_url, ref, operation_kind,
           operation_digest, ?, request_id, run_id, employee_id, agent_id, issued_to_runtime, 'ISSUED', now(),
           now() + interval '5 minutes' FROM repository_credential_leases WHERE id=?`,
          randomUUID(),
          randomUUID(),
          leaseId,
        ),
      ),
    ).resolves.toEqual({ changes: 0 });
    await expect(
      db.store.tenant('org_other', () =>
        db.store.run(
          `INSERT INTO organization_source_control_connections (id,organization_id,provider,name,git_host,
           api_base_url,credential_mode,secret_ref,allowed_repositories,status,created_by,created_at,updated_by,updated_at)
           VALUES (?,?,'github','x','github.com','https://api.github.com','static_token','secret://x','[]','ACTIVE',
           'admin_demo',now(),'admin_demo',now())`,
          randomUUID(),
          org,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Administration is tenant-scoped too.
    expect(
      await db.sourceControl.list({ ...admin, organizationId: 'org_other' }).catch(() => []),
    ).toEqual([]);
  });

  it('mints a repository-scoped, read-only GitHub App token and revokes it on release', async () => {
    const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    secrets.set(org, 'github-app-key', pem);
    await connect({
      credentialMode: 'github_app',
      secretRef: 'secret://github-app-key',
      appId: '12345',
      installationId: '678',
    });
    const minted = `ghs_${randomBytes(20).toString('hex')}`;
    githubApp.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json(
        {
          token: minted,
          repositories: [{ full_name: 'acme/private' }],
          permissions: { contents: 'read', metadata: 'read' },
        },
        { status: 201 },
      );
    });
    const { grant, leaseId } = await issued();
    const redeemed = (await redeem(grant, leaseId).expect(200)).body;
    expect(redeemed.credential).toEqual({
      scheme: 'basic',
      username: 'x-access-token',
      password: minted,
    });

    const [url, init] = githubApp.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/678/access_tokens');
    expect(JSON.parse(String(init.body))).toEqual({
      repositories: ['private'],
      permissions: { contents: 'read' },
    });
    expect(init.redirect).toBe('error');
    const jwt = (init.headers as Record<string, string>)['authorization']!.slice('Bearer '.length);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verifier.verify(appKey.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString()) as {
      iss: string;
      exp: number;
      iat: number;
    };
    expect(parsed.iss).toBe('12345');
    expect(parsed.exp - parsed.iat).toBe(600);

    // Releasing the lease revokes the token at GitHub, authenticated by the token itself.
    await release(leaseId, grant.payload.grantId).expect(200);
    const revoke = githubApp.mock.calls.at(-1) as [string, RequestInit];
    expect(revoke[0]).toBe('https://api.github.com/installation/token');
    expect(revoke[1].method).toBe('DELETE');
    expect((revoke[1].headers as Record<string, string>)['authorization']).toBe(`Bearer ${minted}`);
    // Neither the App key nor the minted token is stored anywhere.
    expect(await everything(db)).not.toContain(minted);
    expect(await everything(db)).not.toContain(pem.split('\n')[2]!);
  });

  it('refuses a GitHub App token broader than one read-only repository', async () => {
    const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    secrets.set(
      org,
      'github-app-key',
      appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    await connect({
      credentialMode: 'github_app',
      secretRef: 'secret://github-app-key',
      appId: '12345',
      installationId: '678',
    });
    const broad = `ghs_${randomBytes(20).toString('hex')}`;
    const replies = [
      {
        token: broad,
        repositories: [{ full_name: 'acme/private' }, { full_name: 'acme/other' }],
        permissions: { contents: 'read' },
      },
      {
        token: broad,
        repositories: [{ full_name: 'acme/private' }],
        permissions: { contents: 'write' },
      },
      { token: broad, permissions: { contents: 'read' } },
    ];
    githubApp.mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(replies.shift(), { status: 201 }),
    );
    const context = await issued();
    let grant = context.grant;
    for (let i = 0; i < 3; i++) {
      const leaseId = grant.payload.credential!.leaseId;
      const refused = await redeem(grant, leaseId).expect(502);
      expect(JSON.stringify(refused.body)).not.toContain(broad);
      expect(await lease(leaseId)).toMatchObject({
        status: 'REVOKED',
        revoke_reason: 'CREDENTIAL_SCOPE_UNEXPECTED',
      });
      // The over-broad token was withdrawn straight away.
      expect((githubApp.mock.calls.at(-1) as [string, RequestInit])[1].method).toBe('DELETE');
      grant = await context.grantFor({ ...checkout, path: `retry-${i}` });
    }
    expect(await everything(db)).not.toContain(broad);
  });

  it('issues Bitbucket repository access tokens through the same lease', async () => {
    const bitbucketToken = `ATCTT${randomBytes(24).toString('hex')}`;
    secrets.set(org, 'bitbucket-read', bitbucketToken);
    await expect(
      connect({
        provider: 'bitbucket',
        credentialMode: 'github_app',
        appId: '1',
        installationId: '2',
      }),
    ).rejects.toThrow();
    const connection = await db.sourceControl.create(admin, {
      provider: 'bitbucket',
      name: 'Bitbucket read access',
      gitHost: 'bitbucket.org',
      apiBaseUrl: 'https://api.bitbucket.org/2.0',
      credentialMode: 'static_token',
      secretRef: 'secret://bitbucket-read',
      allowedRepositories: ['acme-workspace/storefront'],
    });
    // The agent's signed configuration decides the repository; point this agent at Bitbucket.
    const pending = await db.requestProvisioning(
      employeeId,
      {
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.2.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: {
          projectName: 'Storefront',
          repositoryUrl: 'https://bitbucket.org/acme-workspace/storefront.git',
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
    const { grantFor } = await running();
    const grant = await grantFor({
      kind: 'git.checkout',
      repositoryUrl: 'https://bitbucket.org/acme-workspace/storefront.git',
      ref: 'main',
      path: 'repo',
    });
    expect(grant.payload.credential).toMatchObject({
      provider: 'bitbucket',
      gitHost: 'bitbucket.org',
    });
    expect(grant.payload.limits.network.allowedHosts).toEqual(['bitbucket.org']);
    const leaseId = grant.payload.credential!.leaseId;
    expect((await redeem(grant, leaseId).expect(200)).body.credential).toEqual({
      scheme: 'basic',
      username: 'x-token-auth',
      password: bitbucketToken,
    });
    expect(await lease(leaseId)).toMatchObject({
      connection_id: connection.id,
      provider: 'bitbucket',
      repository: 'acme-workspace/storefront',
    });
    expect(await everything(db)).not.toContain(bitbucketToken);
  });

  it('stores no credential in any table: events, audit, alerts, webhooks or quality results', async () => {
    await connect();
    const { grant, leaseId, run } = await issued();
    await redeem(grant, leaseId).expect(200);
    await release(leaseId, grant.payload.grantId).expect(200);
    await redeem(grant, leaseId).expect(409);
    const dump = await everything(db);
    expect(dump).toContain(leaseId); // The scan really reads the lease and audit tables.
    expect(dump).toContain('credential.lease.redeemed');
    for (const form of [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString('base64')])
      expect(dump).not.toContain(form);
    // What the run's owner and administrators can read holds it nowhere either.
    const visible = [
      (await demoRequest(app).get(`/api/execution/v1/runs/${run.id}`).expect(200)).text,
      (await demoRequest(app).get(`/api/execution/v1/runs/${run.id}/events`).expect(200)).text,
      JSON.stringify(await db.credentials.list(admin)),
      JSON.stringify(await db.sourceControl.list(admin)),
      JSON.stringify(await db.quality.overview(admin, {})),
    ].join('\n');
    expect(visible).not.toContain(TOKEN);
  });
});

/** Every row of every table, as text. */
async function everything(db: ControlPlaneDatabase): Promise<string> {
  const sql = rawSql(db);
  const tables = await sql
    .prepare(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    )
    .all<{ table_name: string }>();
  expect(tables.length).toBeGreaterThan(40);
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = await sql
      .prepare(`SELECT row_to_json(t)::text AS row FROM "${table_name}" t`)
      .all<{ row: string }>();
    parts.push(...rows.map((item) => item.row));
  }
  return parts.join('\n');
}
