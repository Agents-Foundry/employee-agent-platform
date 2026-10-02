import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ExecuteOperationResponse,
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
import { ExecutionRefused, ExecutionService } from '../src/execution-service.js';
import { GrantVerifier } from '../src/grant-verifier.js';
import { runProcess } from '../src/process-runner.js';
import {
  ContainerExecutionProvider,
  defaultEgressProxyDirectory,
  dockerRunArgs,
  egressProxyArgs,
} from '../src/providers/container-provider.js';
import { LocalExecutionProvider } from '../src/providers/local-provider.js';
import { createExecutionServer } from '../src/server.js';
import { StateStore } from '../src/state-store.js';

const controlPlane = generateKeyPairSync('ed25519');
const spki = controlPlane.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const keyId = createHash('sha256')
  .update(controlPlane.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

/** A stand-in Playwright CLI committed in the test repository: prints a JSON report. */
const fakePlaywright = `
const failing = (process.env.BASE_URL || '').includes('fail');
process.stdout.write(JSON.stringify({
  stats: { expected: 3, unexpected: failing ? 1 : 0, flaky: 0, skipped: 1 },
  args: process.argv.slice(2),
  leaked: process.env.AF_TEST_SECRET ?? null,
}));
process.exit(failing ? 1 : 0);
`;

let fixtures: string;
let repositoryUrl: string;

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'af-exec-fixture-'));
  const source = join(fixtures, 'source');
  mkdirSync(join(source, 'node_modules', '@playwright', 'test'), { recursive: true });
  writeFileSync(join(source, 'README.md'), '# Checkout app\n');
  writeFileSync(join(source, 'node_modules', '@playwright', 'test', 'cli.js'), fakePlaywright);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: source,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A', '-f');
  git('commit', '-q', '-m', 'initial');
  const bare = join(fixtures, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', source, bare], { stdio: 'pipe' });
  repositoryUrl = pathToFileURL(bare).href;
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

function grantFor(
  operation: ExecutionOperation,
  overrides: Partial<ExecutionGrantPayload> = {},
  key: KeyObject = controlPlane.privateKey,
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
      network: { mode: 'NONE', allowedHosts: [] },
    },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    ...overrides,
  };
  return {
    payload,
    algorithm: 'Ed25519',
    keyId,
    signature: sign(null, Buffer.from(executionGrantSigningInput(payload)), key).toString('base64'),
  };
}

const THREAD = randomUUID();

describe('execution runtime', () => {
  let root: string;
  let state: StateStore;
  let service: ExecutionService;
  const make = (allowUnsandboxed = false, allowFileRepositories = true) =>
    new ExecutionService({
      verifier: new GrantVerifier(spki),
      provider: new LocalExecutionProvider({ allowFileRepositories }),
      state,
      artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
      workspaceRoot: root,
      allowUnsandboxed,
    });
  const run = (operation: ExecutionOperation, grant = grantFor(operation), target = service) =>
    target.execute(
      { protocol: EXECUTION_PROTOCOL_V1, grant, operation },
      new AbortController().signal,
    );
  const refusal = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'no refusal';
    } catch (error) {
      return error instanceof ExecutionRefused ? `${error.status} ${error.code}` : String(error);
    }
  };
  const checkout = { kind: 'git.checkout' as const, repositoryUrl: '', ref: 'main', path: 'repo' };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-exec-'));
    state = new StateStore(':memory:');
    service = make();
  });
  afterEach(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('checks out a repository once per grant and replays the recorded response', async () => {
    const operation = { ...checkout, repositoryUrl };
    const grant = grantFor(operation);
    const first = await run(operation, grant);
    expect(first.result).toMatchObject({ status: 'SUCCEEDED', exitCode: 0 });
    expect(first.output).toMatch(/Checked out main of .* into repo at [0-9a-f]{40}\./);
    expect(first.workspace.state).toBe('READY');
    // Replaying the same grant returns the stored response without doing the work again.
    expect(await run(operation, grant)).toEqual(first);

    const read = await run({ kind: 'file.read', path: 'repo/README.md' });
    expect(read).toMatchObject({ output: '# Checkout app\n', result: { status: 'SUCCEEDED' } });
    expect(read.workspace.id).toBe(first.workspace.id);
    const status = await run({ kind: 'git.status', path: 'repo' });
    expect(status.output).toContain('## main');

    const again = await run({ ...operation });
    expect(again.result.error?.code).toBe('PATH_ALREADY_EXISTS');
    const missing = await run({ kind: 'file.read', path: 'repo/nope.md' });
    expect(missing.result).toMatchObject({ status: 'FAILED', error: { code: 'PATH_NOT_FOUND' } });
  });

  it('refuses forged, expired, mismatched and replayed-while-running grants before any work', async () => {
    const operation: ExecutionOperation = { kind: 'file.read', path: 'x.txt' };
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(await refusal(run(operation, grantFor(operation, {}, other)))).toBe('403 GRANT_INVALID');
    const tampered = grantFor(operation);
    tampered.payload.correlation.threadId = randomUUID();
    expect(await refusal(run(operation, tampered))).toBe('403 GRANT_INVALID');
    expect(
      await refusal(
        run(
          operation,
          grantFor(operation, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
        ),
      ),
    ).toBe('403 GRANT_EXPIRED');
    expect(await refusal(run({ kind: 'file.read', path: 'other.txt' }, grantFor(operation)))).toBe(
      '403 GRANT_OPERATION_MISMATCH',
    );
    expect(await refusal(run(operation, grantFor(operation, { isolation: 'sandboxed' })))).toBe(
      '403 ISOLATION_UNAVAILABLE',
    );
    expect(
      (await run(operation, grantFor(operation, { isolation: 'sandboxed' }), make(true))).result
        .status,
    ).toBe('FAILED');
    // Paths are validated before a grant is even considered.
    for (const path of ['../escape', '/etc/passwd', 'C:\\\\Windows', 'repo/.git/config', 'a//b'])
      expect(
        await refusal(run({ kind: 'file.read', path } as ExecutionOperation, grantFor(operation))),
      ).toBe('400 EXECUTION_OPERATION_INVALID');
    expect(
      (await run({ kind: 'command', command: 'git', args: ['status'], cwd: '.' })).result,
    ).toMatchObject({ status: 'DENIED', error: { code: 'OPERATION_NOT_SUPPORTED' } });
  });

  it('keeps workspaces per thread and fails explicitly when one is lost', async () => {
    await run({ ...checkout, repositoryUrl });
    const otherThread = { kind: 'file.read' as const, path: 'repo/README.md' };
    const elsewhere = await run(
      otherThread,
      grantFor(otherThread, {
        correlation: { ...grantFor(otherThread).payload.correlation, threadId: randomUUID() },
      }),
    );
    expect(elsewhere.result.error?.code).toBe('PATH_NOT_FOUND');

    const workspace = state.workspace({
      organizationId: 'org_a',
      employeeId: 'employee_a',
      agentId: 'agent_a',
      threadId: THREAD,
    })!;
    rmSync(join(root, 'workspaces', workspace.id), { recursive: true, force: true });
    const lost = await run({ kind: 'file.read', path: 'repo/README.md' });
    expect(lost).toMatchObject({
      result: { status: 'FAILED', error: { code: 'WORKSPACE_LOST' } },
      workspace: { id: workspace.id, state: 'LOST' },
    });
    // Still lost: the runtime never silently recreates it.
    expect((await run({ ...checkout, repositoryUrl })).result.error?.code).toBe('WORKSPACE_LOST');
  });

  it('runs Playwright with a scrubbed environment and stores the report as evidence', async () => {
    process.env['AF_TEST_SECRET'] = 'must-not-leak';
    try {
      await run({ ...checkout, repositoryUrl });
      const passing = await run({
        kind: 'playwright.run',
        project: 'smoke',
        baseUrl: 'https://qa.example.com',
        path: 'repo',
      });
      expect(passing.result.status).toBe('SUCCEEDED');
      expect(passing.output).toBe(
        'Playwright project smoke against https://qa.example.com: 3 passed, 0 failed, 0 flaky, 1 skipped.',
      );
      expect(passing.artifacts).toEqual([
        expect.objectContaining({
          type: 'test_report',
          name: 'playwright-report.json',
          storageReference: expect.stringMatching(/^artifact:\/\/execution-local\/org_a\//),
        }),
      ]);
      const key = passing.artifacts[0]!.storageReference.replace('artifact://execution-local/', '');
      const report = JSON.parse(readFileSync(join(root, 'artifacts', ...key.split('/')), 'utf8'));
      expect(report.args).toEqual([
        'test',
        '--project=smoke',
        '--reporter=json',
        expect.stringMatching(/^--output=\.af-playwright-[0-9a-f-]{36}$/),
        '--trace=retain-on-failure',
      ]);
      expect(report.leaked).toBeNull();

      const failing = await run({
        kind: 'playwright.run',
        project: 'smoke',
        baseUrl: 'https://fail.qa.example.com',
        path: 'repo',
      });
      expect(failing.result).toMatchObject({
        status: 'FAILED',
        exitCode: 1,
        error: { code: 'PLAYWRIGHT_TESTS_FAILED' },
      });
      const notInstalled = await run({
        kind: 'playwright.run',
        project: 'smoke',
        baseUrl: 'https://qa.example.com',
      });
      expect(notInstalled.result.error?.code).toBe('PLAYWRIGHT_NOT_INSTALLED');
    } finally {
      delete process.env['AF_TEST_SECRET'];
    }
  });

  it('writes files inside the workspace only, never through links or into .git', async () => {
    const first = await run({ ...checkout, repositoryUrl });
    const workspace = join(root, 'workspaces', first.workspace.id);
    const created = await run({
      kind: 'file.write',
      path: 'repo/src/banner.ts',
      content: 'export const banner = 1;\n',
    });
    expect(created).toMatchObject({
      result: { status: 'SUCCEEDED' },
      output: 'Created repo/src/banner.ts (25 bytes).',
    });
    expect(readFileSync(join(workspace, 'repo', 'src', 'banner.ts'), 'utf8')).toBe(
      'export const banner = 1;\n',
    );
    expect(
      (await run({ kind: 'file.write', path: 'repo/README.md', content: '# New\n' })).output,
    ).toBe('Updated repo/README.md (6 bytes).');
    expect((await run({ kind: 'git.status', path: 'repo' })).output).toContain(' M README.md');

    // A directory link inside the workspace pointing outside it is never written through.
    const outside = mkdtempSync(join(tmpdir(), 'af-outside-'));
    try {
      symlinkSync(outside, join(workspace, 'repo', 'link'), 'junction');
      const escaped = await run({ kind: 'file.write', path: 'repo/link/x.txt', content: 'x' });
      expect(escaped.result).toMatchObject({
        status: 'FAILED',
        error: { code: 'PATH_OUTSIDE_WORKSPACE' },
      });
      const nested = await run({ kind: 'file.write', path: 'repo/link/a/b.txt', content: 'x' });
      expect(nested.result.error?.code).toBe('PATH_OUTSIDE_WORKSPACE');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    for (const operation of [
      { kind: 'file.write', path: 'repo/.git/config', content: 'x' },
      { kind: 'file.write', path: '../x', content: 'x' },
      { kind: 'file.write', path: 'big.txt', content: 'x'.repeat(128 * 1024 + 1) },
    ])
      expect(await refusal(run(operation as ExecutionOperation))).toBe(
        '400 EXECUTION_OPERATION_INVALID',
      );
    // The local provider never runs repository code.
    const command = await run({ kind: 'command', command: 'npm', args: ['test'], cwd: 'repo' });
    expect(command.result).toMatchObject({
      status: 'DENIED',
      error: { code: 'OPERATION_NOT_SUPPORTED' },
    });
  });

  it('refuses file:// repositories unless explicitly enabled', async () => {
    const response = await run({ ...checkout, repositoryUrl }, undefined, make(false, false));
    expect(response.result.error?.code).toBe('REPOSITORY_PROTOCOL_FORBIDDEN');
  });

  it('never installs dependencies on the local provider, which cannot confine network', async () => {
    const response = await run({
      kind: 'dependencies.install',
      path: '.',
      registryUrl: 'https://registry.npmjs.org/',
    });
    expect(response.result).toMatchObject({
      status: 'DENIED',
      error: { code: 'OPERATION_NOT_SUPPORTED' },
    });
  });

  it('serves the protocol over HTTP with health, routing and error mapping', async () => {
    const server = createExecutionServer(service, new LocalExecutionProvider());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/execution/v1/health`)).json()).toMatchObject({
        status: 'ok',
        provider: 'local',
        isolation: 'local',
      });
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      const operation: ExecutionOperation = { kind: 'file.read', path: 'x.txt' };
      const post = (body: unknown, type = 'application/json') =>
        fetch(`${base}/execution/v1/operations`, {
          method: 'POST',
          headers: { 'content-type': type },
          body: JSON.stringify(body),
        });
      expect((await post({}, 'text/plain')).status).toBe(415);
      const forged = await post({
        protocol: EXECUTION_PROTOCOL_V1,
        grant: grantFor(operation, {}, generateKeyPairSync('ed25519').privateKey),
        operation,
      });
      expect(forged.status).toBe(403);
      expect(await forged.json()).toEqual({ error: 'GRANT_INVALID' });
      const ok = await post({
        protocol: EXECUTION_PROTOCOL_V1,
        grant: grantFor(operation),
        operation,
      });
      const body = (await ok.json()) as ExecuteOperationResponse;
      expect(body.result.error?.code).toBe('PATH_NOT_FOUND');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('container provider', () => {
  const limits = {
    timeoutMs: 60_000,
    cpuMillis: 1500,
    memoryMb: 512,
    maxProcesses: 32,
    network: { mode: 'NONE' as const, allowedHosts: [] },
  };

  it('builds a locked-down docker run with only the given environment', () => {
    process.env['AF_TEST_SECRET'] = 'must-not-leak';
    try {
      const args = dockerRunArgs({
        name: 'af-exec-1',
        image: 'node:22-bookworm-slim',
        workspaceRoot: '/srv/ws/1',
        cwd: 'repo',
        argv: ['npm', 'run', 'test'],
        env: { HOME: '/tmp' },
        limits,
        network: 'none',
        user: '1000:1000',
      });
      const flag = (name: string) => args[args.indexOf(name) + 1];
      expect(flag('--network')).toBe('none');
      expect(flag('--cpus')).toBe('1.500');
      expect(flag('--memory')).toBe('512m');
      expect(flag('--memory-swap')).toBe('512m');
      expect(flag('--pids-limit')).toBe('32');
      expect(flag('--cap-drop')).toBe('ALL');
      expect(flag('--security-opt')).toBe('no-new-privileges');
      expect(flag('--pull')).toBe('never');
      expect(flag('--user')).toBe('1000:1000');
      expect(flag('--mount')).toBe('type=bind,source=/srv/ws/1,target=/workspace');
      expect(flag('--workdir')).toBe('/workspace/repo');
      expect(args).toContain('--read-only');
      expect(args.slice(-4)).toEqual(['node:22-bookworm-slim', 'npm', 'run', 'test']);
      expect(args.filter((arg) => arg === '--env')).toHaveLength(1);
      expect(args.join(' ')).not.toContain('must-not-leak');
    } finally {
      delete process.env['AF_TEST_SECRET'];
    }
  });

  it('builds a locked-down egress proxy that runs only the mounted proxy script', () => {
    const run = {
      name: 'af-egress-1',
      image: 'node:22-bookworm-slim',
      directory: '/opt/af/sandbox',
      allowedHosts: ['qa.example.com', 'registry.npmjs.org'],
      user: '1000:1000',
    };
    const args = egressProxyArgs(run);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--network')).toBe('bridge');
    expect(flag('--cap-drop')).toBe('ALL');
    expect(flag('--security-opt')).toBe('no-new-privileges');
    expect(flag('--pull')).toBe('never');
    expect(flag('--memory')).toBe('128m');
    expect(flag('--mount')).toBe('type=bind,source=/opt/af/sandbox,target=/egress,readonly');
    expect(args).toContain('--read-only');
    expect(args).toContain('EGRESS_ALLOWED_HOSTS=qa.example.com,registry.npmjs.org');
    expect(args.slice(-3)).toEqual(['node:22-bookworm-slim', 'node', '/egress/egress-proxy.mjs']);
    // A host cannot smuggle a second host (or anything else) into the proxy's allow-list.
    expect(() => egressProxyArgs({ ...run, allowedHosts: ['qa.example.com,evil.test'] })).toThrow();
    expect(defaultEgressProxyDirectory()).toMatch(/sandbox$/);
  });

  const image = 'node:22-bookworm-slim';
  const docker = (() => {
    try {
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!docker)(`with Docker (${image})`, () => {
    let root: string;
    let state: StateStore;
    let service: ExecutionService;
    const checkout = { kind: 'git.checkout' as const, ref: 'main', path: 'repo' };
    const sandboxed = (
      operation: ExecutionOperation,
      overrides: Partial<ExecutionGrantPayload> = {},
    ) =>
      service.execute(
        {
          protocol: EXECUTION_PROTOCOL_V1,
          grant: grantFor(operation, { isolation: 'sandboxed', limits, ...overrides }),
          operation,
        },
        new AbortController().signal,
      );

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'af-sandbox-'));
      state = new StateStore(':memory:');
      service = new ExecutionService({
        verifier: new GrantVerifier(spki),
        provider: new ContainerExecutionProvider({ image, allowFileRepositories: true }),
        state,
        artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
        workspaceRoot: root,
        // No allowUnsandboxed: the container provider satisfies sandboxed grants itself.
      });
    });
    afterEach(() => {
      state.close();
      rmSync(root, { recursive: true, force: true });
    });

    it('runs project scripts with no network, no secrets and a read-only root filesystem', async () => {
      process.env['AF_TEST_SECRET'] = 'must-not-leak';
      try {
        expect((await sandboxed({ ...checkout, repositoryUrl })).result.status).toBe('SUCCEEDED');
        const probe = [
          "const fs = require('node:fs');",
          "console.log('secret:' + (process.env.AF_TEST_SECRET ?? 'absent'));",
          "try { fs.writeFileSync('/etc/af-probe', 'x'); console.log('rootfs:writable'); } catch { console.log('rootfs:read-only'); }",
          "fs.writeFileSync('dist.txt', 'built');",
          "fetch('https://example.com').then(() => console.log('network:open'), () => console.log('network:blocked'));",
        ].join('\n');
        for (const [path, content] of [
          ['repo/probe.js', probe],
          [
            'repo/package.json',
            JSON.stringify({
              scripts: { test: 'node probe.js', hang: 'node -e "setInterval(()=>{},1000)"' },
            }),
          ],
        ])
          expect(
            (await sandboxed({ kind: 'file.write', path: path!, content: content! })).result.status,
          ).toBe('SUCCEEDED');
        const tested = await sandboxed({
          kind: 'command',
          command: 'npm',
          args: ['run', 'test'],
          cwd: 'repo',
        });
        expect(tested.result.status, tested.output).toBe('SUCCEEDED');
        expect(tested.output).toContain('secret:absent');
        expect(tested.output).toContain('rootfs:read-only');
        expect(tested.output).toContain('network:blocked');
        const built = await sandboxed({ kind: 'file.read', path: 'repo/dist.txt' });
        expect(built.output).toBe('built');
      } finally {
        delete process.env['AF_TEST_SECRET'];
      }
    });

    it('kills timed-out containers and refuses unlisted commands and unenforceable egress', async () => {
      await sandboxed({ ...checkout, repositoryUrl });
      await sandboxed({
        kind: 'file.write',
        path: 'repo/package.json',
        content: JSON.stringify({ scripts: { hang: 'node -e "setInterval(()=>{},1000)"' } }),
      });
      const hung = await sandboxed(
        { kind: 'command', command: 'npm', args: ['run', 'hang'], cwd: 'repo' },
        { limits: { ...limits, timeoutMs: 5000 } },
      );
      expect(hung.result).toMatchObject({
        status: 'TIMED_OUT',
        error: { code: 'OPERATION_TIMED_OUT' },
      });
      const running = execFileSync(
        'docker',
        ['ps', '--all', '--quiet', '--filter', 'name=af-exec-'],
        { encoding: 'utf8' },
      ).trim();
      expect(running).toBe('');
      const node = await sandboxed({ kind: 'command', command: 'node', args: ['-v'], cwd: 'repo' });
      expect(node.result.error?.code).toBe('COMMAND_NOT_ALLOWED');
      const egress = await sandboxed(
        { kind: 'command', command: 'npm', args: ['run', 'hang'], cwd: 'repo' },
        {
          limits: {
            ...limits,
            network: { mode: 'ALLOW_LIST', allowedHosts: ['registry.npmjs.org'] },
          },
        },
      );
      expect(egress.result).toMatchObject({
        status: 'DENIED',
        error: { code: 'EGRESS_CONTROL_UNAVAILABLE' },
      });
    });

    it('lets networked grants reach only their allowed hosts, through the egress proxy', async () => {
      const qa = http.createServer((request, response) => response.end(`qa saw ${request.url}`));
      await new Promise<void>((resolve) => qa.listen(0, '127.0.0.1', resolve));
      const port = (qa.address() as AddressInfo).port;
      try {
        service = new ExecutionService({
          verifier: new GrantVerifier(spki),
          provider: new ContainerExecutionProvider({
            image,
            allowFileRepositories: true,
            egressProxyDirectory: defaultEgressProxyDirectory()!,
          }),
          state,
          artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
          workspaceRoot: root,
        });
        // Docker Desktop's name for the machine running the containers.
        const networked = {
          limits: {
            ...limits,
            network: { mode: 'ALLOW_LIST' as const, allowedHosts: ['host.docker.internal'] },
          },
        };
        await sandboxed({ ...checkout, repositoryUrl });
        const probe = [
          "const net = require('node:net');",
          'const report = (label, url) => fetch(url).then(',
          '  async (reply) => console.log(`${label}:${reply.status}:${(await reply.text()).trim()}`),',
          '  () => console.log(`${label}:error`),',
          ');',
          '(async () => {',
          `  await report('allowed', 'http://host.docker.internal:${port}/hello');`,
          "  await report('denied', 'http://example.com/');",
          "  await report('deniedTls', 'https://example.com/');",
          '  await new Promise((resolve) => {',
          "    const socket = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });",
          "    socket.on('connect', () => { console.log('direct:open'); socket.destroy(); resolve(); });",
          "    socket.on('error', () => { console.log('direct:blocked'); resolve(); });",
          "    socket.on('timeout', () => { console.log('direct:blocked'); socket.destroy(); resolve(); });",
          '  });',
          '})();',
        ].join('\n');
        for (const [path, content] of [
          ['repo/probe.js', probe],
          ['repo/package.json', JSON.stringify({ scripts: { probe: 'node probe.js' } })],
        ])
          await sandboxed({ kind: 'file.write', path: path!, content: content! });
        const probed = await sandboxed(
          { kind: 'command', command: 'npm', args: ['run', 'probe'], cwd: 'repo' },
          networked,
        );
        expect(probed.result.status, probed.output).toBe('SUCCEEDED');
        expect(probed.output).toContain('allowed:200:qa saw /hello');
        // Node's fetch tunnels plain HTTP too, so a refused tunnel surfaces as a network error.
        expect(probed.output).toContain('denied:error');
        expect(probed.output).toContain('deniedTls:error');
        expect(probed.output).toContain('direct:blocked');
        expect(probed.output).toContain(
          'Network access outside the grant was blocked: example.com:80, example.com:443',
        );
        const evidence = probed.artifacts.find((artifact) => artifact.name === 'egress.log')!;
        const key = evidence.storageReference.replace('artifact://execution-local/', '');
        const log = readFileSync(join(root, 'artifacts', ...key.split('/')), 'utf8');
        expect(log).toMatch(/"decision":"ALLOW","method":"\w+","host":"host.docker.internal"/);
        expect(log).toContain(
          '"decision":"DENY","method":"CONNECT","host":"example.com","port":443',
        );
        expect(log).not.toContain('hello');

        // QA's Playwright runs need no unrestricted-egress override any more.
        const tested = await sandboxed(
          {
            kind: 'playwright.run',
            project: 'smoke',
            baseUrl: `http://host.docker.internal:${port}`,
            path: 'repo',
          },
          networked,
        );
        expect(tested.result.status, tested.output).toBe('SUCCEEDED');
        expect(tested.output).toContain('3 passed');

        const leftovers = (...filter: string[]) =>
          execFileSync('docker', filter, { encoding: 'utf8' }).trim();
        expect(leftovers('ps', '--all', '--quiet', '--filter', 'name=af-egress-')).toBe('');
        expect(leftovers('network', 'ls', '--quiet', '--filter', 'name=af-net-')).toBe('');
      } finally {
        qa.close();
      }
    });

    it('installs exactly the locked dependencies from the granted registry, without install scripts', async () => {
      const name = 'af-fixture-greeting';
      const tgz = npmTarball({
        'package/package.json': JSON.stringify({
          name,
          version: '1.0.0',
          main: 'index.js',
          scripts: {
            postinstall:
              "node -e \"require('fs').writeFileSync('/workspace/repo/POSTINSTALL_RAN','x')\"",
          },
        }),
        'package/index.js': "module.exports = 'hello from the mirror';\n",
      });
      const fetched: string[] = [];
      const mirror = http.createServer((request, response) => {
        fetched.push(request.url ?? '');
        if (request.url === `/${name}/-/${name}-1.0.0.tgz`) response.end(tgz);
        else response.writeHead(404).end('{}');
      });
      await new Promise<void>((resolve) => mirror.listen(0, '127.0.0.1', resolve));
      const port = (mirror.address() as AddressInfo).port;
      const integrity = (content: Buffer) =>
        `sha512-${createHash('sha512').update(content).digest('base64')}`;
      const lockfile = (hash: string) =>
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'app', version: '1.0.0', dependencies: { [name]: '1.0.0' } },
            [`node_modules/${name}`]: {
              version: '1.0.0',
              // Locked against the public registry; the install rewrites it to the mirror.
              resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
              integrity: hash,
            },
          },
        });
      try {
        service = new ExecutionService({
          verifier: new GrantVerifier(spki),
          provider: new ContainerExecutionProvider({
            image,
            allowFileRepositories: true,
            egressProxyDirectory: defaultEgressProxyDirectory()!,
          }),
          state,
          artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
          workspaceRoot: root,
        });
        const networked = {
          limits: {
            ...limits,
            network: { mode: 'ALLOW_LIST' as const, allowedHosts: ['host.docker.internal'] },
          },
        };
        const install = {
          kind: 'dependencies.install' as const,
          path: 'repo',
          registryUrl: `http://host.docker.internal:${port}/`,
        };
        await sandboxed({ ...checkout, repositoryUrl });
        await sandboxed({
          kind: 'file.write',
          path: 'repo/package.json',
          content: JSON.stringify({
            name: 'app',
            version: '1.0.0',
            dependencies: { [name]: '1.0.0' },
            scripts: { test: `node -e "console.log(require('${name}'))"` },
          }),
        });
        const missing = await sandboxed(install, networked);
        expect(missing.result.error?.code).toBe('LOCKFILE_REQUIRED');

        await sandboxed({
          kind: 'file.write',
          path: 'repo/package-lock.json',
          content: lockfile(integrity(tgz)),
        });
        const installed = await sandboxed(install, networked);
        expect(installed.result.status, installed.output).toBe('SUCCEEDED');
        expect(installed.output).toMatch(/added 1 package/);
        expect(fetched).toEqual([`/${name}/-/${name}-1.0.0.tgz`]);
        // Install scripts never ran, and the operation's npm cache is gone.
        const ran = await sandboxed({ kind: 'file.read', path: 'repo/POSTINSTALL_RAN' });
        expect(ran.result.error?.code).toBe('PATH_NOT_FOUND');
        const workspace = join(root, 'workspaces', readdirSync(join(root, 'workspaces'))[0]!);
        expect(readdirSync(workspace).filter((entry) => entry.startsWith('.af-npm-cache'))).toEqual(
          [],
        );

        // Installed dependencies serve later offline scripts.
        const tested = await sandboxed({
          kind: 'command',
          command: 'npm',
          args: ['run', 'test'],
          cwd: 'repo',
        });
        expect(tested.output).toContain('hello from the mirror');

        // A tarball that does not match the lockfile is rejected.
        await sandboxed({
          kind: 'file.write',
          path: 'repo/package-lock.json',
          content: lockfile(integrity(Buffer.from('something else'))),
        });
        const tampered = await sandboxed(install, networked);
        expect(tampered.result).toMatchObject({
          status: 'FAILED',
          error: { code: 'INSTALL_FAILED' },
        });
        expect(tampered.output).toMatch(/EINTEGRITY|integrity/i);
      } finally {
        mirror.close();
      }
    });
  });
});

/** A gzipped ustar archive, the npm package tarball format. */
function npmTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(' '.repeat(8), 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('process runner', () => {
  it('kills the process tree on timeout and caps output', async () => {
    const started = Date.now();
    const slow = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
      env: { PATH: process.env['PATH'] ?? '' },
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    const loud = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(5000))"],
      {
        cwd: tmpdir(),
        env: { PATH: process.env['PATH'] ?? '' },
        timeoutMs: 10_000,
        maxOutputBytes: 100,
      },
    );
    expect(loud).toMatchObject({ exitCode: 0, truncated: true });
    expect(loud.stdout).toHaveLength(100);
  });
});

describe('architecture boundaries', () => {
  it('imports only contracts from the monorepo, never control-plane or agent-runtime code', async () => {
    const { readFileSync: read } = await import('node:fs');
    const source = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(source);
    for (const file of files)
      for (const [, specifier] of read(file, 'utf8').matchAll(/from '([^']+)'/g))
        expect(
          specifier!.startsWith('node:') ||
            specifier === 'zod' ||
            specifier === '@agents-foundry/contracts' ||
            specifier!.startsWith('./') ||
            (specifier!.startsWith('../') &&
              !specifier!.includes('apps/') &&
              (!specifier!.includes('packages/') ||
                specifier!.includes('packages/contracts/') ||
                // Provider-neutral tracing and metrics; it depends on nothing else here.
                specifier!.includes('packages/telemetry/'))),
          `${file} imports ${specifier}`,
        ).toBe(true);
  });
});
