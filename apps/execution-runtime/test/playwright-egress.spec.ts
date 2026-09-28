/**
 * Opt-in end-to-end check (ADR 0016): real `@playwright/test` and real Chromium in the
 * Playwright image, behind the egress proxy. It needs the Playwright image and internet
 * access to registry.npmjs.org, so it runs only with AF_PLAYWRIGHT_CHECK=1:
 *
 *   AF_PLAYWRIGHT_CHECK=1 npx vitest run test/playwright-egress.spec.ts
 *
 * AF_PLAYWRIGHT_IMAGE overrides the image, for example one built from
 * sandbox/playwright.Dockerfile.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
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
import { ExecutionArtifactStore } from '../src/artifact-store.js';
import { ExecutionService } from '../src/execution-service.js';
import { GrantVerifier } from '../src/grant-verifier.js';
import {
  ContainerExecutionProvider,
  defaultEgressProxyDirectory,
} from '../src/providers/container-provider.js';
import { StateStore } from '../src/state-store.js';

const PLAYWRIGHT_VERSION = '1.63.0';
/** The official image, or one built from sandbox/playwright.Dockerfile. */
const PLAYWRIGHT_IMAGE =
  process.env['AF_PLAYWRIGHT_IMAGE'] ?? `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`;
const SANDBOX_IMAGE = 'node:22-bookworm-slim';
const REGISTRY = 'https://registry.npmjs.org/';

const enabled = (() => {
  if (process.env['AF_PLAYWRIGHT_CHECK'] !== '1') return false;
  try {
    for (const image of [PLAYWRIGHT_IMAGE, SANDBOX_IMAGE])
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

const controlPlane = generateKeyPairSync('ed25519');
const spki = controlPlane.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const keyId = createHash('sha256')
  .update(controlPlane.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const thread = randomUUID();

function grantFor(operation: ExecutionOperation, limits: ResourceLimits): SignedExecutionGrant {
  const now = Date.now();
  const payload: ExecutionGrantPayload = {
    kind: EXECUTION_GRANT_KIND,
    grantId: randomUUID(),
    requestId: randomUUID(),
    action: 'qa.execute_playwright',
    correlation: {
      organizationId: 'org_a',
      employeeId: 'employee_a',
      agentId: 'agent_a',
      threadId: thread,
      runId: randomUUID(),
      stepId: randomUUID(),
      toolCallId: randomUUID(),
    },
    operationKind: operation.kind,
    operationDigest: createHash('sha256').update(canonicalManifest(operation)).digest('hex'),
    isolation: 'sandboxed',
    limits,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
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

describe.skipIf(!enabled)(`Playwright ${PLAYWRIGHT_VERSION} behind the egress proxy`, () => {
  let fixtures: string;
  let root: string;
  let repositoryUrl: string;
  let state: StateStore;
  let service: ExecutionService;
  let qa: http.Server;
  let qaPort: number;

  beforeAll(async () => {
    fixtures = mkdtempSync(join(tmpdir(), 'af-pw-fixture-'));
    const source = join(fixtures, 'source');
    mkdirSync(join(source, 'tests'), { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'checkout-e2e',
        private: true,
        devDependencies: { '@playwright/test': PLAYWRIGHT_VERSION },
      }),
    );
    writeFileSync(
      join(source, 'playwright.config.js'),
      [
        "const { defineConfig } = require('@playwright/test');",
        'module.exports = defineConfig({',
        "  testDir: 'tests',",
        '  use: { baseURL: process.env.BASE_URL },',
        "  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],",
        '});',
      ].join('\n'),
    );
    writeFileSync(
      join(source, 'tests', 'checkout.spec.js'),
      [
        "const { test, expect } = require('@playwright/test');",
        "test('loads the QA environment', async ({ page }) => {",
        "  await page.goto('/');",
        "  await expect(page.locator('h1')).toHaveText('Checkout');",
        '});',
        "test('cannot reach hosts outside the grant', async ({ page }) => {",
        "  const outcome = await page.goto('https://example.com/').then(",
        '    (response) => response?.status() ?? 0,',
        '    () => 0,',
        '  );',
        '  expect(outcome === 0 || outcome >= 400).toBe(true);',
        '});',
      ].join('\n'),
    );
    // The lockfile is resolved once on the host; the sandbox installs exactly it.
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit'], {
      cwd: source,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: source,
        stdio: 'pipe',
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    const bare = join(fixtures, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', source, bare], { stdio: 'pipe' });
    repositoryUrl = pathToFileURL(bare).href;

    qa = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>QA</title><h1>Checkout</h1>');
    });
    await new Promise<void>((resolve) => qa.listen(0, '127.0.0.1', resolve));
    qaPort = (qa.address() as AddressInfo).port;

    root = mkdtempSync(join(tmpdir(), 'af-pw-'));
    state = new StateStore(':memory:');
    service = new ExecutionService({
      verifier: new GrantVerifier(spki),
      provider: new ContainerExecutionProvider({
        image: SANDBOX_IMAGE,
        playwrightImage: PLAYWRIGHT_IMAGE,
        allowFileRepositories: true,
        egressProxyDirectory: defaultEgressProxyDirectory()!,
      }),
      state,
      artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
      workspaceRoot: root,
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => qa?.close(resolve));
    state?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  /** The limits the control plane grants (256 processes for Playwright), with the hosts. */
  const limits = (allowedHosts: string[], timeoutMs = 600_000): ResourceLimits => ({
    timeoutMs,
    cpuMillis: 2000,
    memoryMb: 2048,
    maxProcesses: 256,
    network: allowedHosts.length
      ? { mode: 'ALLOW_LIST', allowedHosts }
      : { mode: 'NONE', allowedHosts: [] },
  });
  const execute = (operation: ExecutionOperation, grantLimits: ResourceLimits) =>
    service.execute(
      { protocol: EXECUTION_PROTOCOL_V1, grant: grantFor(operation, grantLimits), operation },
      new AbortController().signal,
    );
  const artifact = (reference: string) =>
    readFileSync(
      join(root, 'artifacts', ...reference.replace('artifact://execution-local/', '').split('/')),
      'utf8',
    );

  it('runs real Chromium against the allowed QA host and nothing else', async () => {
    const checkout = await execute(
      { kind: 'git.checkout', repositoryUrl, ref: 'main', path: 'repo' },
      limits([]),
    );
    expect(checkout.result.status, checkout.output).toBe('SUCCEEDED');

    const install = await execute(
      { kind: 'dependencies.install', path: 'repo', registryUrl: REGISTRY },
      limits(['registry.npmjs.org']),
    );
    expect(install.result.status, install.output).toBe('SUCCEEDED');

    const run = await execute(
      {
        kind: 'playwright.run',
        project: 'chromium',
        baseUrl: `http://host.docker.internal:${qaPort}`,
        path: 'repo',
      },
      limits(['host.docker.internal']),
    );
    const log = run.artifacts.find((entry) => entry.name === 'egress.log');
    const egress = log ? artifact(log.storageReference) : '';
    const read = (name: string) => {
      const entry = run.artifacts.find((candidate) => candidate.name === name);
      return entry ? artifact(entry.storageReference) : '';
    };
    // Each failed test's first error line, so a failure explains itself.
    const errors = [...read('playwright-report.json').matchAll(/"message":\s*"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => (JSON.parse(`"${match[1]}"`) as string).split('\n')[0])
      .join('\n');
    console.log(
      `[playwright] ${run.result.status}: ${run.output}\n${errors}\n` +
        `${read('playwright-stderr.log').slice(-2000)}\n[egress]\n${egress}`,
    );
    expect(run.result.status, run.output).toBe('SUCCEEDED');
    expect(run.output).toContain('2 passed, 0 failed');
    // The QA page loaded, which is only possible through the proxy: the sandbox has no other
    // route. The proxy also saw, and refused, the browser's attempt to leave the allow-list.
    expect(egress).toMatch(/"decision":"ALLOW","method":"\w+","host":"host.docker.internal"/);
    expect(egress).toMatch(/"decision":"DENY","method":"CONNECT","host":"example.com","port":443/);
  });
});
