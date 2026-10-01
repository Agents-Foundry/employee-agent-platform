import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CredentialReleaseOutcome,
  ExecutionGrantPayload,
  ExecutionOperation,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import {
  EXECUTION_GRANT_KIND,
  EXECUTION_PROTOCOL_V1,
  executionGrantSigningInput,
} from '../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { ExecutionArtifactStore } from '../src/artifact-store.js';
import {
  CheckoutCredential,
  CredentialRefused,
  type CredentialSource,
} from '../src/credential-client.js';
import { ExecutionService } from '../src/execution-service.js';
import { GrantVerifier } from '../src/grant-verifier.js';
import { LocalExecutionProvider } from '../src/providers/local-provider.js';
import { StateStore } from '../src/state-store.js';
import {
  gitServerAvailable,
  selfSignedCertificate,
  startGitServer,
  type GitServer,
} from './support/git-server.js';

const controlPlane = generateKeyPairSync('ed25519');
const der = controlPlane.publicKey.export({ type: 'spki', format: 'der' });
const spki = der.toString('base64');
const keyId = createHash('sha256').update(der).digest('hex');

const HOST = 'github.test';
const EVIL = 'evil.test';
const TOKEN = `ghs_${randomBytes(24).toString('hex')}`;
const USER = 'x-access-token';
const BASIC = Buffer.from(`${USER}:${TOKEN}`).toString('base64');
const REPOSITORY = `https://${HOST}/acme/private.git`;
const THREAD = randomUUID();

const available = gitServerAvailable();

/** Every file under `directory` that contains the token in any form. */
function leaks(directory: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else {
        const content = readFileSync(child).toString('latin1');
        if ([TOKEN, BASIC, encodeURIComponent(TOKEN)].some((form) => content.includes(form)))
          found.push(child);
      }
    }
  };
  walk(directory);
  return found;
}

class FakeCredentials implements CredentialSource {
  redeemed: string[] = [];
  released: { leaseId: string; grantId: string; outcome: CredentialReleaseOutcome }[] = [];
  refuse: string | undefined;
  expiresAt = Date.now() + 60_000;
  password = TOKEN;

  async redeem(_grant: SignedExecutionGrant, leaseId: string) {
    this.redeemed.push(leaseId);
    if (this.refuse) throw new CredentialRefused(this.refuse);
    return new CheckoutCredential(
      { scheme: 'basic', username: USER, password: this.password },
      this.expiresAt,
    );
  }

  async release(leaseId: string, grantId: string, outcome: CredentialReleaseOutcome) {
    this.released.push({ leaseId, grantId, outcome });
  }
}

function grantFor(
  operation: ExecutionOperation,
  overrides: Partial<ExecutionGrantPayload> = {},
): SignedExecutionGrant {
  const now = Date.now();
  const payload: ExecutionGrantPayload = {
    kind: EXECUTION_GRANT_KIND,
    grantId: randomUUID(),
    requestId: randomUUID(),
    action: 'repository.read',
    correlation: {
      organizationId: 'org_a',
      employeeId: 'employee_a',
      agentId: 'agent_a',
      threadId: THREAD,
      runId: randomUUID(),
      stepId: randomUUID(),
      toolCallId: randomUUID(),
    },
    operationKind: operation.kind,
    operationDigest: createHash('sha256').update(canonicalManifest(operation)).digest('hex'),
    isolation: 'local',
    limits: {
      timeoutMs: 60_000,
      cpuMillis: 2000,
      memoryMb: 2048,
      maxProcesses: 64,
      network: { mode: 'ALLOW_LIST', allowedHosts: [HOST] },
    },
    credential: { leaseId: randomUUID(), provider: 'github', gitHost: HOST },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    ...overrides,
  };
  return {
    payload,
    algorithm: 'Ed25519',
    keyId,
    signature: sign(
      null,
      Buffer.from(executionGrantSigningInput(payload)),
      controlPlane.privateKey,
    ).toString('base64'),
  };
}

it('can run the HTTPS git server these tests need', () => {
  // Locally the suite is skipped without openssl or git http-backend; CI must have both.
  if (process.env['CI']) expect(available).toBe(true);
});

describe.skipIf(!available)('authenticated checkout (ADR 0031)', () => {
  let fixtures: string;
  let git: GitServer;
  let evil: GitServer;
  let root: string;
  let state: StateStore;
  let credentials: FakeCredentials;
  let service: ExecutionService;

  beforeAll(async () => {
    fixtures = mkdtempSync(join(tmpdir(), 'af-private-'));
    const projectRoot = join(fixtures, 'repos');
    const commit = (name: string, files: Record<string, string>, extra?: (cwd: string) => void) => {
      const source = join(fixtures, 'src', name);
      mkdirSync(source, { recursive: true });
      for (const [path, content] of Object.entries(files))
        writeFileSync(join(source, path), content);
      const run = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
          cwd: source,
          stdio: 'pipe',
        });
      run('init', '-q', '-b', 'main');
      run('add', '-A');
      extra?.(source);
      run('commit', '-q', '-m', 'initial');
      const bare = join(projectRoot, 'acme', `${name}.git`);
      mkdirSync(join(projectRoot, 'acme'), { recursive: true });
      execFileSync('git', ['clone', '-q', '--bare', source, bare], { stdio: 'pipe' });
    };
    commit('private', { 'README.md': '# Private app\n' });
    commit(
      'with-submodule',
      {
        'README.md': '# Has a submodule\n',
        '.gitmodules': `[submodule "inner"]\n\tpath = inner\n\turl = https://${EVIL}/acme/inner.git\n`,
      },
      (cwd) =>
        execFileSync(
          'git',
          ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},inner`],
          { cwd, stdio: 'pipe' },
        ),
    );
    const certificate = selfSignedCertificate(join(fixtures, 'tls'), [HOST, EVIL]);
    git = await startGitServer({ projectRoot, certificate, credentials: `${USER}:${TOKEN}` });
    evil = await startGitServer({ projectRoot, certificate });
  });
  afterAll(async () => {
    await git?.close();
    await evil?.close();
    rmSync(fixtures, { recursive: true, force: true, maxRetries: 5 });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-private-run-'));
    state = new StateStore(join(root, 'state.db'));
    credentials = new FakeCredentials();
    service = make(credentials);
    git.requests.length = 0;
    evil.requests.length = 0;
    git.mode = 'serve';
  });
  afterEach(() => {
    state.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const make = (source: CredentialSource | undefined, target = state) =>
    new ExecutionService({
      verifier: new GrantVerifier(spki),
      provider: new LocalExecutionProvider({
        gitCaFile: git.caFile,
        egress: {
          lookup: async () => ['127.0.0.1'],
          isBlocked: () => false,
          portFor: (host) => (host === HOST ? git.port : evil.port),
        },
      }),
      state: target,
      artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
      workspaceRoot: root,
      ...(source ? { credentials: source } : {}),
    });
  const checkout = (url = REPOSITORY, ref = 'main', path = 'app'): ExecutionOperation => ({
    kind: 'git.checkout',
    repositoryUrl: url,
    ref,
    path,
  });
  const run = (
    operation: ExecutionOperation,
    grant = grantFor(operation),
    signal = new AbortController().signal,
    target = service,
  ) => target.execute({ protocol: EXECUTION_PROTOCOL_V1, grant, operation }, signal);
  const workspaceOf = (id: string) => join(root, 'workspaces', id);

  it('clones a private repository and leaves no trace of the credential', async () => {
    const operation = checkout();
    const grant = grantFor(operation);
    const response = await run(operation, grant);
    expect(response.result).toMatchObject({ status: 'SUCCEEDED', exitCode: 0 });
    const target = join(workspaceOf(response.workspace.id), 'app');
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Private app\n');

    // The server required the credential, on this repository only.
    expect(git.requests.length).toBeGreaterThan(0);
    expect(git.requests.every((request) => request.authorization === `Basic ${BASIC}`)).toBe(true);
    expect(git.requests.every((request) => request.url.startsWith('/acme/private.git/'))).toBe(
      true,
    );

    // Nothing durable holds it: not git's config, the workspace, scratch, artifacts or state.
    const config = readFileSync(join(target, '.git', 'config'), 'utf8');
    expect(config).toContain(`url = ${REPOSITORY}`);
    expect(config).not.toMatch(/extraheader|helper|x-access-token/i);
    expect(leaks(root)).toEqual([]);
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(response)).not.toContain(BASIC);

    // One redemption, one release, and nothing left to clean up.
    expect(credentials.redeemed).toEqual([grant.payload.credential!.leaseId]);
    expect(credentials.released).toEqual([
      {
        leaseId: grant.payload.credential!.leaseId,
        grantId: grant.payload.grantId,
        outcome: 'SUCCEEDED',
      },
    ]);
    expect(state.pendingCredentials()).toEqual([]);
  });

  it('replays a used grant without redeeming again', async () => {
    const operation = checkout();
    const grant = grantFor(operation);
    const first = await run(operation, grant);
    const again = await run(operation, grant);
    expect(again).toEqual(first);
    expect(credentials.redeemed).toHaveLength(1);
  });

  it('never falls back to an anonymous clone', async () => {
    // No credential source configured: refused before any request.
    const operation = checkout();
    const refused = await run(operation, grantFor(operation), undefined, make(undefined));
    expect(refused.result).toMatchObject({
      status: 'FAILED',
      error: { code: 'CREDENTIALS_UNAVAILABLE' },
    });
    // The control plane refuses the lease: reported by code, still no request.
    credentials.refuse = 'CREDENTIAL_LEASE_REVOKED';
    const revoked = await run(checkout(REPOSITORY, 'main', 'again'));
    expect(revoked.result.error).toEqual({
      code: 'CREDENTIAL_REFUSED',
      message: 'The control plane refused the repository credential (CREDENTIAL_LEASE_REVOKED).',
    });
    expect(git.requests).toEqual([]);
    expect(existsSync(join(workspaceOf(revoked.workspace.id), 'again'))).toBe(false);
  });

  it('refuses an expired credential and a credential for any other operation', async () => {
    credentials.expiresAt = Date.now() - 1;
    const expired = await run(checkout());
    expect(expired.result.error?.code).toBe('CREDENTIAL_EXPIRED');
    expect(git.requests).toEqual([]);
    expect(credentials.released.at(-1)?.outcome).toBe('FAILED');

    const status: ExecutionOperation = { kind: 'git.status', path: '.' };
    const forbidden = await run(status, grantFor(status));
    expect(forbidden.result.error?.code).toBe('CREDENTIAL_OPERATION_FORBIDDEN');
    expect(credentials.redeemed).toHaveLength(1);
  });

  it('fails a checkout that is redirected, without sending the credential elsewhere', async () => {
    git.mode = 'redirect';
    git.redirectTo = `https://${EVIL}`;
    const response = await run(checkout());
    expect(response.result.status).toBe('FAILED');
    expect(evil.requests).toEqual([]);
    expect(existsSync(join(workspaceOf(response.workspace.id), 'app'))).toBe(false);
    expect(credentials.released.at(-1)?.outcome).toBe('FAILED');
    expect(JSON.stringify(response)).not.toContain(BASIC);
    expect(leaks(root)).toEqual([]);
  });

  it('cannot reach a host the grant does not allow', async () => {
    // The grant names another host than the URL, as a tampered operation could not (the digest
    // binds it), but as a rewritten remote could: the proxy refuses the connection.
    const operation = checkout(`https://${EVIL}/acme/private.git`);
    const response = await run(operation);
    expect(response.result.error?.code).toBe('EGRESS_DENIED');
    expect(evil.requests).toEqual([]);
    expect(git.requests).toEqual([]);
  });

  it('redacts the credential from git errors, output and evidence', async () => {
    git.mode = 'leak';
    const response = await run(checkout());
    expect(response.result.status).toBe('FAILED');
    expect(response.output).toContain('[REDACTED]');
    expect(response.artifacts.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(response)).not.toContain(BASIC);
    // The stored evidence (artifacts are under the runtime root) is redacted too.
    expect(leaks(root)).toEqual([]);
  });

  it('does not fetch submodules or send them the credential', async () => {
    const response = await run(checkout(`https://${HOST}/acme/with-submodule.git`));
    expect(response.result.status).toBe('SUCCEEDED');
    expect(response.output).toContain('submodules were not fetched');
    const target = join(workspaceOf(response.workspace.id), 'app');
    expect(existsSync(join(target, '.gitmodules'))).toBe(true);
    expect(existsSync(join(target, 'inner', '.git'))).toBe(false);
    expect(existsSync(join(target, '.git', 'modules'))).toBe(false);
    expect(evil.requests).toEqual([]);
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toMatch(/^\[submodule/m);
  });

  it('discards a failed checkout and releases the lease', async () => {
    const response = await run(checkout(REPOSITORY, 'no-such-branch'));
    expect(response.result).toMatchObject({
      status: 'FAILED',
      error: { code: 'GIT_CHECKOUT_FAILED' },
    });
    expect(existsSync(join(workspaceOf(response.workspace.id), 'app'))).toBe(false);
    expect(credentials.released.at(-1)?.outcome).toBe('FAILED');
    expect(leaks(root)).toEqual([]);
    // The path is free again for a correct checkout.
    expect((await run(checkout())).result.status).toBe('SUCCEEDED');
  });

  it('discards a timed-out checkout and releases the lease', async () => {
    git.mode = 'stall';
    const operation = checkout();
    const grant = grantFor(operation);
    grant.payload.limits.timeoutMs = 1500;
    const resigned = grantFor(operation, { limits: grant.payload.limits });
    const response = await run(operation, resigned);
    expect(response.result).toMatchObject({
      status: 'TIMED_OUT',
      error: { code: 'OPERATION_TIMED_OUT' },
    });
    expect(existsSync(join(workspaceOf(response.workspace.id), 'app'))).toBe(false);
    expect(credentials.released.at(-1)?.outcome).toBe('TIMED_OUT');
    expect(state.pendingCredentials()).toEqual([]);
    expect(leaks(root)).toEqual([]);
  });

  it('discards a cancelled checkout and releases the lease', async () => {
    git.mode = 'stall';
    const controller = new AbortController();
    const pending = run(checkout(), undefined, controller.signal);
    await expect.poll(() => git.requests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    controller.abort();
    const response = await pending;
    expect(response.result.status).toBe('FAILED');
    expect(existsSync(join(workspaceOf(response.workspace.id), 'app'))).toBe(false);
    expect(credentials.released.at(-1)?.outcome).toBe('CANCELLED');
    expect(state.pendingCredentials()).toEqual([]);
    expect(leaks(root)).toEqual([]);
  });

  it('cleans up after a crash: partial checkout removed, lease ended, grant closed', async () => {
    // What a process that died mid-clone leaves behind.
    const operation = checkout();
    const grant = grantFor(operation);
    const workspace = state.createWorkspace(grant.payload.correlation);
    const target = join(workspaceOf(workspace.id), 'app');
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, '.git', 'config'), 'partial');
    expect(state.claimGrant(grant.payload.grantId)).toEqual({ kind: 'claimed' });
    state.recordPendingCredential({
      grantId: grant.payload.grantId,
      leaseId: grant.payload.credential!.leaseId,
      requestId: grant.payload.requestId,
      workspaceId: workspace.id,
      target,
    });
    state.close();

    // The next process.
    state = new StateStore(join(root, 'state.db'));
    const restarted = make(credentials, state);
    expect(await restarted.recover()).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(credentials.released).toEqual([
      {
        leaseId: grant.payload.credential!.leaseId,
        grantId: grant.payload.grantId,
        outcome: 'INTERRUPTED',
      },
    ]);
    expect(state.pendingCredentials()).toEqual([]);
    // The grant cannot be used again; it reports the interruption and redeems nothing.
    const replay = await run(operation, grant, undefined, restarted);
    expect(replay.result.error?.code).toBe('OPERATION_INTERRUPTED');
    expect(credentials.redeemed).toEqual([]);
    expect(await restarted.recover()).toBe(0);
  });
});
