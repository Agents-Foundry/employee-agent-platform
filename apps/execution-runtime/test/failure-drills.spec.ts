import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArtifactUploadDescriptor,
  ExecutionGrantPayload,
  ExecutionOperation,
  ResourceLimits,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import {
  EXECUTION_GRANT_KIND,
  EXECUTION_PROTOCOL_V1,
  executionGrantSigningInput,
} from '../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { runtimeTransportPaths } from '../../../packages/contracts/src/runtime/v1/transport.js';
import { MemorySpanExporter, Telemetry } from '../../../packages/telemetry/src/index.js';
import { ExecutionArtifactStore } from '../src/artifact-store.js';
import { ControlPlaneCredentialClient, CredentialRefused } from '../src/credential-client.js';
import { ExecutionService } from '../src/execution-service.js';
import { GrantVerifier } from '../src/grant-verifier.js';
import { ContainerExecutionProvider } from '../src/providers/container-provider.js';
import type { ExecutionProvider, ProviderOutcome } from '../src/providers/execution-provider.js';
import { LocalExecutionProvider } from '../src/providers/local-provider.js';
import { EVIDENCE_KINDS, collectPlaywrightEvidence } from '../src/providers/playwright-evidence.js';
import { createExecutionServer } from '../src/server.js';
import { StateStore } from '../src/state-store.js';

const controlPlane = generateKeyPairSync('ed25519');
const spki = controlPlane.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const keyId = createHash('sha256')
  .update(controlPlane.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const THREAD = randomUUID();
const RUN = randomUUID();

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
      runId: RUN,
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
    signature: sign(
      null,
      Buffer.from(executionGrantSigningInput(payload)),
      controlPlane.privateKey,
    ).toString('base64'),
  };
}

describe('execution runtime failure drills', () => {
  let root: string;
  let spans: MemorySpanExporter;
  let telemetry: Telemetry;
  const states: StateStore[] = [];
  const openState = (path = join(root, 'state.db')) => {
    const state = new StateStore(path);
    states.push(state);
    return state;
  };
  const make = (
    state: StateStore,
    provider: ExecutionProvider,
    extra: Partial<ConstructorParameters<typeof ExecutionService>[0]> = {},
  ) =>
    new ExecutionService({
      verifier: new GrantVerifier(spki),
      provider,
      state,
      artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
      workspaceRoot: root,
      telemetry,
      ...extra,
    });
  const run = (
    service: ExecutionService,
    operation: ExecutionOperation,
    grant = grantFor(operation),
  ) =>
    service.execute(
      { protocol: EXECUTION_PROTOCOL_V1, grant, operation },
      new AbortController().signal,
    );
  const metric = async (name: string, labels: Record<string, string> = {}) =>
    (await telemetry.metrics.collect())
      .find((family) => family.name === name)
      ?.points.filter((point) =>
        Object.entries(labels).every(([key, value]) => point.labels[key] === value),
      )
      .reduce((total, point) => total + (point.count ?? point.value), 0) ?? 0;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-exec-drill-'));
    spans = new MemorySpanExporter();
    telemetry = new Telemetry('execution-runtime', [spans]);
  });
  afterEach(() => {
    for (const state of states.splice(0)) state.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('7. closes the operation a stopped runtime was in the middle of, and never runs it twice (fail closed)', async () => {
    let started = 0;
    let release!: () => void;
    const hang = new Promise<void>((resolve) => (release = resolve));
    const dying: ExecutionProvider = {
      id: 'dying',
      isolation: 'local',
      enforces: ['timeout'],
      execute: async (): Promise<ProviderOutcome> => {
        started += 1;
        await hang;
        return { status: 'SUCCEEDED', output: 'late', truncated: false, artifacts: [] };
      },
    };
    const operation: ExecutionOperation = { kind: 'file.write', path: 'a.txt', content: 'one' };
    const grant = grantFor(operation, { action: 'repository.write' });
    // The first process starts the operation and never finishes it.
    const first = make(openState(), dying);
    const abandoned = run(first, operation, grant).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(1);

    // The next process, on the same state: the grant is closed, with what happened.
    const local = new LocalExecutionProvider();
    const restarted = make(openState(), local);
    expect(await restarted.recover()).toBe(1);
    const replay = await run(restarted, operation, grant);
    expect(replay.result).toMatchObject({
      status: 'FAILED',
      requestId: grant.payload.requestId,
      error: { code: 'OPERATION_INTERRUPTED' },
    });
    expect(started).toBe(1);
    expect(await restarted.recover()).toBe(0);
    // The workspace is usable again, under a new grant.
    const next = await run(
      restarted,
      operation,
      grantFor(operation, { action: 'repository.write' }),
    );
    expect(next.result.status).toBe('SUCCEEDED');
    expect(next.workspace.id).toBe(replay.workspace.id);
    release();
    await abandoned;
  });

  it('7b. keeps a grant usable when the runtime stopped before anything ran under it', async () => {
    const operation: ExecutionOperation = { kind: 'file.write', path: 'b.txt', content: 'two' };
    const grant = grantFor(operation, { action: 'repository.write' });
    const state = openState();
    // Claimed, and the process died before a workspace was even chosen.
    expect(state.claimGrant(grant.payload.grantId)).toEqual({ kind: 'claimed' });
    const restarted = make(openState(), new LocalExecutionProvider());
    expect(await restarted.recover()).toBe(0);
    expect((await run(restarted, operation, grant)).result.status).toBe('SUCCEEDED');
  });

  describe('egress', () => {
    /** A stand-in docker client: records every call and fails where the test says. */
    const fakeDocker = (failOn: string, name = 'docker') => {
      const log = join(root, `${name}.log`);
      const script = join(root, `${name}.mjs`);
      writeFileSync(
        script,
        `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const call = args.slice(0, 2).join(' ');
if (call === ${JSON.stringify(failOn)}) { console.error('simulated failure'); process.exit(1); }
if (call === 'logs' || args[0] === 'logs') console.log(${JSON.stringify(process.env['AF_DRILL_PROXY_LOG'] ?? '')});
process.exit(0);
`,
      );
      return {
        options: { dockerExecutable: process.execPath, dockerArguments: [script] },
        calls: () =>
          existsSync(log)
            ? readFileSync(log, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as string[])
            : [],
      };
    };
    const limits: ResourceLimits = {
      timeoutMs: 30_000,
      cpuMillis: 1000,
      memoryMb: 512,
      maxProcesses: 32,
      network: { mode: 'ALLOW_LIST', allowedHosts: ['registry.npmjs.org'] },
    };
    const command: ExecutionOperation = {
      kind: 'command',
      command: 'npm',
      args: ['run', 'test'],
      cwd: 'repo',
    };
    const prepared = async (provider: ExecutionProvider) => {
      const service = make(openState(), provider, { allowUnsandboxed: true });
      const write: ExecutionOperation = {
        kind: 'file.write',
        path: 'repo/package.json',
        content: '{}',
      };
      await run(service, write, grantFor(write, { action: 'repository.write' }));
      return service;
    };
    const sandboxed = (operation: ExecutionOperation) =>
      grantFor(operation, { action: 'workspace.command', isolation: 'sandboxed', limits });

    it('11. never starts the sandbox when the egress proxy fails to start (fail closed)', async () => {
      const docker = fakeDocker('run --detach');
      const service = await prepared(
        new ContainerExecutionProvider({
          image: 'sandbox:test',
          egressProxyDirectory: root,
          ...docker.options,
        }),
      );
      const response = await run(service, command, sandboxed(command));
      expect(response.result).toMatchObject({
        status: 'FAILED',
        error: { code: 'EGRESS_PROXY_UNAVAILABLE' },
      });
      const calls = docker.calls().map((args) => args.slice(0, 2).join(' '));
      // The private network was created and the proxy attempted; the sandbox never ran.
      expect(calls.slice(0, 2)).toEqual(['network create', 'run --detach']);
      expect(calls).not.toContain('run --rm');
      // Everything created for the operation was removed.
      expect(calls.filter((call) => call === 'rm --force')).toHaveLength(2);
      expect(calls.at(-1)).toBe('network rm');
      expect(await metric('af_egress_failures_total', { code: 'EGRESS_PROXY_UNAVAILABLE' })).toBe(
        1,
      );
      expect(
        await metric('af_execution_operations_total', {
          kind: 'command',
          code: 'EGRESS_PROXY_UNAVAILABLE',
        }),
      ).toBe(1);
    });

    it('11b. never starts the sandbox when its private network cannot be created, or no proxy is configured', async () => {
      const docker = fakeDocker('network create');
      const failing = await prepared(
        new ContainerExecutionProvider({
          image: 'sandbox:test',
          egressProxyDirectory: root,
          ...docker.options,
        }),
      );
      expect((await run(failing, command, sandboxed(command))).result).toMatchObject({
        status: 'FAILED',
        error: { code: 'EGRESS_PROXY_UNAVAILABLE' },
      });
      expect(docker.calls().map((args) => args[0])).not.toContain('run');

      // No allow-list proxy at all: a grant that needs the network is denied outright.
      const none = fakeDocker('never', 'docker-unproxied');
      const unproxied = make(
        openState(join(root, 'second.db')),
        new ContainerExecutionProvider({ image: 'sandbox:test', ...none.options }),
        { workspaceRoot: join(root, 'second') },
      );
      const write: ExecutionOperation = {
        kind: 'file.write',
        path: 'repo/package.json',
        content: '{}',
      };
      await run(
        unproxied,
        write,
        grantFor(write, { action: 'repository.write', isolation: 'sandboxed' }),
      );
      const denied = await run(unproxied, command, sandboxed(command));
      expect(denied.result).toMatchObject({
        status: 'DENIED',
        error: { code: 'EGRESS_CONTROL_UNAVAILABLE' },
      });
      expect(none.calls()).toEqual([]);
    });
  });

  describe('browser evidence', () => {
    it('collects traces and screenshots within limits and nothing else', async () => {
      const output = join(root, 'evidence');
      mkdirSync(join(output, 'cart-chromium'), { recursive: true });
      mkdirSync(join(output, 'login-chromium'), { recursive: true });
      writeFileSync(join(output, 'cart-chromium', 'trace.zip'), Buffer.alloc(2048, 1));
      writeFileSync(join(output, 'cart-chromium', 'test-failed-1.png'), Buffer.alloc(512, 2));
      writeFileSync(join(output, 'login-chromium', 'trace.zip'), Buffer.alloc(1024, 3));
      writeFileSync(join(output, 'login-chromium', 'video.webm'), Buffer.alloc(256, 4));
      // Not evidence: other files, empty files, and anything over its limit.
      writeFileSync(join(output, 'cart-chromium', 'notes.txt'), 'secret notes');
      writeFileSync(join(output, 'cart-chromium', 'empty.png'), '');
      const trace = EVIDENCE_KINDS.find((kind) => kind.type === 'playwright_trace')!;
      writeFileSync(join(output, 'huge'), '');
      mkdirSync(join(output, 'huge-chromium'));
      writeFileSync(join(output, 'huge-chromium', 'trace.zip'), Buffer.alloc(trace.maxBytes + 1));
      // A link out of the directory is never followed.
      writeFileSync(join(root, 'outside.png'), Buffer.alloc(64, 9));
      try {
        symlinkSync(join(root, 'outside.png'), join(output, 'cart-chromium', 'link.png'));
      } catch {
        // Windows without the privilege to create links: the rest of the test still holds.
      }
      const collected = await collectPlaywrightEvidence(output);
      expect(
        collected.artifacts.map((artifact) => [
          artifact.name,
          artifact.type,
          artifact.mediaType,
          artifact.retention,
          artifact.content.byteLength,
        ]),
      ).toEqual([
        ['cart-chromium-test-failed-1.png', 'screenshot', 'image/png', 'STANDARD_30D', 512],
        ['cart-chromium-trace.zip', 'playwright_trace', 'application/zip', 'STANDARD_30D', 2048],
        ['login-chromium-trace.zip', 'playwright_trace', 'application/zip', 'STANDARD_30D', 1024],
        ['login-chromium-video.webm', 'video', 'video/webm', 'EPHEMERAL', 256],
      ]);
      expect(collected.omitted).toBe(2);
      expect(await collectPlaywrightEvidence(join(root, 'missing'))).toEqual({
        artifacts: [],
        omitted: 0,
      });
    });

    it('stores a failed run with its trace, screenshot, console output and report, each with a retention class', async () => {
      // A stand-in Playwright CLI: writes a trace and a screenshot where it is told to.
      const project = join(root, 'workspaces');
      const cli = `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const output = process.argv.find((arg) => arg.startsWith('--output=')).slice(9);
mkdirSync(join(output, 'cart-chromium'), { recursive: true });
writeFileSync(join(output, 'cart-chromium', 'trace.zip'), Buffer.alloc(4096, 7));
writeFileSync(join(output, 'cart-chromium', 'test-failed-1.png'), Buffer.alloc(300, 8));
process.stderr.write('1 failed\\n');
process.stdout.write(JSON.stringify({ stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 0 } }));
process.exit(1);
`;
      const uploads: { artifact: ArtifactUploadDescriptor; bytes: number }[] = [];
      const service = make(openState(), new LocalExecutionProvider(), {
        evidence: {
          upload: async (_grant, artifact, content) => {
            uploads.push({ artifact, bytes: content.byteLength });
            return {
              artifactId: artifact.id,
              storageReference: `artifact://memory-store/org_a/${RUN}/${artifact.id}`,
              checksum: artifact.checksum,
              sizeBytes: artifact.sizeBytes,
            };
          },
        },
      });
      const write: ExecutionOperation = {
        kind: 'file.write',
        path: 'repo/package.json',
        content: '{}',
      };
      const prepared = await run(service, write, grantFor(write, { action: 'repository.write' }));
      const repo = join(project, prepared.workspace.id, 'repo');
      mkdirSync(join(repo, 'node_modules', '@playwright', 'test'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', '@playwright', 'test', 'cli.js'), cli);

      const operation: ExecutionOperation = {
        kind: 'playwright.run',
        project: 'chromium',
        baseUrl: 'https://qa.example.com',
        path: 'repo',
      };
      const response = await run(
        service,
        operation,
        grantFor(operation, { action: 'qa.execute_playwright' }),
      );
      expect(response.result).toMatchObject({
        status: 'FAILED',
        error: { code: 'PLAYWRIGHT_TESTS_FAILED' },
      });
      expect(response.output).toContain('Evidence stored: 1 trace, 1 screenshot.');
      expect(
        response.artifacts.map((artifact) => [
          artifact.name,
          artifact.type,
          artifact.mediaType,
          artifact.retentionPolicy,
        ]),
      ).toEqual([
        ['playwright-report.json', 'test_report', 'application/json', 'EXTENDED_365D'],
        ['playwright-console.log', 'console_log', 'text/plain', 'STANDARD_30D'],
        ['cart-chromium-test-failed-1.png', 'screenshot', 'image/png', 'STANDARD_30D'],
        ['cart-chromium-trace.zip', 'playwright_trace', 'application/zip', 'STANDARD_30D'],
      ]);
      // Every artifact went through the control plane's store, with its own hash and size.
      expect(uploads.map((upload) => upload.bytes)).toEqual([
        response.artifacts[0]!.sizeBytes,
        9,
        300,
        4096,
      ]);
      expect(
        response.artifacts.every((artifact) =>
          artifact.storageReference.startsWith('artifact://memory-store/org_a/'),
        ),
      ).toBe(true);
      // The output directory is removed from the workspace afterwards.
      expect(readdirSync(repo).filter((name) => name.startsWith('.af-playwright-'))).toEqual([]);
      // The operation is one span in the run's trace, under its grant, with no content.
      const span = spans.spans.find(
        (item) => item.attributes['af.operation.kind'] === 'playwright.run',
      )!;
      expect(span).toMatchObject({
        name: 'execution.operation',
        status: 'ERROR',
        attributes: { 'af.run.id': RUN, 'error.code': 'PLAYWRIGHT_TESTS_FAILED' },
      });
      expect(JSON.stringify(spans.spans)).not.toContain('qa.example.com');
    });
  });

  describe('direct upload client (ADR 0037)', () => {
    const key = generateKeyPairSync('ed25519').privateKey;
    const content = Buffer.alloc(6 * 1024 * 1024, 5);
    const artifact: ArtifactUploadDescriptor = {
      id: randomUUID(),
      mediaType: 'application/zip',
      name: 'trace.zip',
      checksum: { algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') },
      sizeBytes: content.byteLength,
      retentionPolicy: 'STANDARD_30D',
    };
    const grant = grantFor({
      kind: 'playwright.run',
      project: 'c',
      baseUrl: 'https://qa.example.com',
    });
    const stored = {
      artifactId: artifact.id,
      storageReference: `artifact://object-store/org_a/${RUN}/${artifact.id}`,
      checksum: artifact.checksum,
      sizeBytes: artifact.sizeBytes,
    };
    type Seen = { method: string; url: string; headers: Record<string, string>; bytes: number };
    const client = (answer: (seen: Seen) => Response) => {
      const calls: Seen[] = [];
      const fetchStub = (async (url: URL | string, init?: RequestInit) => {
        const body = init?.body as Uint8Array | undefined;
        const seen = {
          method: String(init?.method),
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          bytes: body?.byteLength ?? 0,
        };
        calls.push(seen);
        return answer(seen);
      }) as typeof fetch;
      return {
        calls,
        client: new ControlPlaneCredentialClient({
          controlPlaneUrl: 'https://control.example.com',
          runtimeId: 'execution-1',
          privateKey: key,
          fetch: fetchStub,
        }),
      };
    };
    const authorization = (target: 'STORE' | 'CONTROL_PLANE', url: string) =>
      Response.json(
        {
          artifactId: artifact.id,
          target,
          url,
          headers: { 'content-type': 'application/zip', authorization: 'AWS4-HMAC-SHA256 sig' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 },
      );

    it('asks for permission, sends the bytes to the store and has the control plane confirm them', async () => {
      const { client: uploader, calls } = client((seen) =>
        seen.url.endsWith(runtimeTransportPaths.artifactUploadAuthorize)
          ? authorization('STORE', 'https://objects.example.com/bucket/org_a/run/id')
          : seen.url.startsWith('https://objects.example.com/')
            ? new Response(null, { status: 200 })
            : Response.json(stored, { status: 201 }),
      );
      expect(await uploader.upload(grant, artifact, content)).toEqual(stored);
      expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
        ['POST', runtimeTransportPaths.artifactUploadAuthorize],
        ['PUT', '/bucket/org_a/run/id'],
        ['POST', runtimeTransportPaths.artifactUploadComplete],
      ]);
      // The store sees the permission's headers and the bytes: no workload signature, no JSON.
      expect(calls[1]).toMatchObject({
        bytes: content.byteLength,
        headers: { authorization: 'AWS4-HMAC-SHA256 sig', 'content-type': 'application/zip' },
      });
      expect(Object.keys(calls[1]!.headers).some((name) => name.startsWith('x-af-'))).toBe(false);
      // Small artifacts and other media types still travel in the signed request.
      const small = client(() => Response.json({ ...stored, sizeBytes: 4 }, { status: 201 }));
      const tiny = Buffer.from('tiny');
      await small.client
        .upload(
          grant,
          {
            ...artifact,
            sizeBytes: 4,
            checksum: {
              algorithm: 'sha256',
              value: createHash('sha256').update(tiny).digest('hex'),
            },
          },
          tiny,
        )
        .catch(() => undefined);
      expect(small.calls.map((call) => new URL(call.url).pathname)).toEqual([
        runtimeTransportPaths.artifactUploadExecution,
      ]);
    });

    it('sends the bytes to the control plane, signed, when the store cannot take them', async () => {
      const path = `${runtimeTransportPaths.artifactContent}/payload.signature`;
      const { client: uploader, calls } = client((seen) =>
        seen.url.endsWith(runtimeTransportPaths.artifactUploadAuthorize)
          ? authorization('CONTROL_PLANE', path)
          : seen.method === 'PUT'
            ? new Response(null, { status: 204 })
            : Response.json(stored, { status: 201 }),
      );
      expect(await uploader.upload(grant, artifact, content)).toEqual(stored);
      expect(calls[1]).toMatchObject({
        method: 'PUT',
        url: `https://control.example.com${path}`,
        bytes: content.byteLength,
      });
      expect(
        Object.keys(calls[1]!.headers).filter((name) => name.startsWith('x-af-')),
      ).toHaveLength(4);
    });

    it('refuses a permission that points anywhere it should not, and never repeats a store answer', async () => {
      for (const [target, url] of [
        ['STORE', 'http://objects.example.com/bucket/key'],
        ['STORE', 'not a url'],
        ['CONTROL_PLANE', '/runtime/v1/credentials/redeem'],
        ['CONTROL_PLANE', 'https://evil.example.com/runtime/v1/artifact-content/x'],
      ] as const) {
        const { client: uploader, calls } = client(() => authorization(target, url));
        await expect(uploader.upload(grant, artifact, content)).rejects.toMatchObject({
          code: 'ARTIFACT_RESPONSE_INVALID',
        });
        expect(calls).toHaveLength(1);
      }
      const refused = client((seen) =>
        seen.url.endsWith(runtimeTransportPaths.artifactUploadAuthorize)
          ? authorization('STORE', 'https://objects.example.com/bucket/key')
          : new Response('<Error><Bucket>internal-bucket-name</Bucket></Error>', { status: 403 }),
      );
      const error = await refused.client.upload(grant, artifact, content).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CredentialRefused);
      expect(String((error as CredentialRefused).code)).toBe('ARTIFACT_STORE_REFUSED');
      expect(JSON.stringify(error)).not.toContain('internal-bucket-name');
      // A different artifact than the one asked for is not accepted.
      const swapped = client(() =>
        Response.json(
          {
            artifactId: randomUUID(),
            target: 'STORE',
            url: 'https://objects.example.com/bucket/key',
            headers: {},
            expiresAt: new Date().toISOString(),
          },
          { status: 201 },
        ),
      );
      await expect(swapped.client.upload(grant, artifact, content)).rejects.toMatchObject({
        code: 'ARTIFACT_RESPONSE_INVALID',
      });
    });
  });

  it('serves metrics only to a caller with the operator token', async () => {
    const token = 'm'.repeat(48);
    const tokenPath = join(root, 'metrics-token');
    writeFileSync(tokenPath, `${token}\n`);
    const provider = new LocalExecutionProvider();
    const service = make(openState(), provider);
    const operation: ExecutionOperation = { kind: 'file.write', path: 'c.txt', content: 'three' };
    await run(service, operation, grantFor(operation, { action: 'repository.write' }));
    const server = createExecutionServer(service, provider, { telemetry, tokenPath });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const get = (headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${port}/metrics`, { headers });
      expect((await get()).status).toBe(401);
      expect((await get({ authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await get({ authorization: `Bearer ${token}x` })).status).toBe(401);
      const allowed = await get({ authorization: `Bearer ${token}` });
      expect(allowed.status).toBe(200);
      const text = await allowed.text();
      expect(text).toContain(
        'af_execution_operations_total{kind="file.write",status="SUCCEEDED",code="none"} 1',
      );
      expect(text).toContain('af_execution_in_flight 0');
      expect(text).toContain(
        'af_execution_duration_ms_count{kind="file.write",status="SUCCEEDED"} 1',
      );
      // Without the setting there is no such route.
      const plain = createExecutionServer(service, provider);
      await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
      const none = await fetch(
        `http://127.0.0.1:${(plain.address() as { port: number }).port}/metrics`,
      );
      expect(none.status).toBe(404);
      await new Promise((resolve) => plain.close(resolve));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
