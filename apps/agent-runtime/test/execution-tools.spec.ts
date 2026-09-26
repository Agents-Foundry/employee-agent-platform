import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArtifactRegistration, SignedExecutionGrant } from '@agents-foundry/contracts';
import { RuntimeFailure } from '../src/errors.js';
import {
  BrowserTool,
  BuildTool,
  CodeEditorTool,
  RepositoryTool,
} from '../src/tools/execution-tools.js';
import { SourceControlTool } from '../src/tools/source-control-tool.js';
import { ExecutionClient, type ExecutionPort } from '../src/transport/execution-client.js';
import { MemoryArtifactStore } from '../src/tools/artifact-store.js';
import type { ToolExecutionContext } from '../src/tools/runtime-tool.js';
import { correlation, signedManifest } from './fixtures.js';

const grant = { payload: { limits: { timeoutMs: 1000 } } } as unknown as SignedExecutionGrant;

function context(onGrant: () => void, registered: ArtifactRegistration[]): ToolExecutionContext {
  const subject = correlation();
  return {
    correlation: { ...subject, stepId: randomUUID(), toolCallId: randomUUID() },
    manifest: signedManifest(subject),
    artifacts: new MemoryArtifactStore(),
    registerArtifact: async (artifact) => {
      registered.push(artifact);
    },
    signal: new AbortController().signal,
    governedAction: {
      requestId: randomUUID(),
      execute: async () => {
        throw new Error('not used');
      },
      grant: async () => {
        onGrant();
        return grant;
      },
    },
  };
}

describe('execution-runtime tools', () => {
  it('limits each tool to its own operations and sends the operation as the payload', () => {
    const port: ExecutionPort = { execute: async () => Promise.reject(new Error('unused')) };
    const repository = new RepositoryTool(port);
    const browser = new BrowserTool(port);
    expect(repository.sendsParameters && browser.sendsParameters).toBe(true);
    expect(repository.governedAction()).toBe('repository.read');
    expect(browser.governedAction()).toBe('qa.execute_playwright');
    expect(repository.parse({ kind: 'git.status', path: 'repo' })).toEqual({
      kind: 'git.status',
      path: 'repo',
    });
    expect(() =>
      repository.parse({ kind: 'playwright.run', project: 'x', baseUrl: 'https://qa.example.com' }),
    ).toThrow(RuntimeFailure);
    expect(() => browser.parse({ kind: 'file.read', path: 'x' })).toThrow(RuntimeFailure);
    expect(() => repository.parse({ kind: 'file.read', path: '../x' })).toThrow();

    // Phase G tools: writes, project scripts and pull requests each have one action.
    const editor = new CodeEditorTool(port);
    const build = new BuildTool(port);
    const source = new SourceControlTool();
    expect([editor.governedAction(), build.governedAction(), source.governedAction()]).toEqual([
      'repository.write',
      'workspace.command',
      'repository.pull_request.create',
    ]);
    const write = { kind: 'file.write', path: 'repo/a.ts', content: 'x' };
    expect(editor.parse(write)).toEqual(write);
    expect(() => editor.parse({ kind: 'file.read', path: 'repo/a.ts' })).toThrow(RuntimeFailure);
    expect(() => repository.parse(write)).toThrow(RuntimeFailure);
    expect(() => editor.parse({ ...write, path: 'repo/.git/hooks/pre-commit' })).toThrow();
    const script = { kind: 'command', command: 'npm', args: ['run', 'lint'], cwd: 'repo' };
    expect(build.parse(script)).toEqual(script);
    expect(build.summarize(build.parse(script))).toBe('Run npm run lint in repo');
    expect(() => build.parse(write)).toThrow(RuntimeFailure);
    const proposal = {
      repository: 'acme/storefront',
      baseBranch: 'main',
      headBranch: 'agents-foundry/ui-7',
      title: 'Banner',
      body: '',
      path: 'repo',
    };
    expect(source.parse(proposal)).toEqual(proposal);
    // The runtime never supplies file contents for a pull request.
    expect(() => source.parse({ ...proposal, files: [{ path: 'a', content: 'b' }] })).toThrow();
    expect(() => source.parse({ ...proposal, headBranch: 'main' })).toThrow();
  });

  it('executes under a grant, registers evidence and surfaces failures with their output', async () => {
    const artifact: ArtifactRegistration = {
      id: randomUUID(),
      type: 'test_report',
      mediaType: 'application/json',
      name: 'playwright-report.json',
      storageReference: 'artifact://execution-local/org/run/a/playwright-report.json',
      checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
      sizeBytes: 2,
      retentionPolicy: 'STANDARD_30D',
    };
    let status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
    const operations: unknown[] = [];
    const port: ExecutionPort = {
      execute: async (received, operation) => {
        expect(received).toBe(grant);
        operations.push(operation);
        return {
          result: {
            requestId: randomUUID(),
            status,
            artifactIds: [artifact.id],
            durationMs: 5,
            ...(status === 'FAILED'
              ? { error: { code: 'PLAYWRIGHT_TESTS_FAILED', message: '1 failed' } }
              : {}),
          },
          workspace: { id: randomUUID(), state: 'READY' },
          output: '3 passed, 1 failed',
          truncated: false,
          artifacts: [artifact],
        };
      },
    };
    const tool = new BrowserTool(port);
    const input = tool.parse({
      kind: 'playwright.run',
      project: 'smoke',
      baseUrl: 'https://qa.example.com',
    });
    let grants = 0;
    const registered: ArtifactRegistration[] = [];
    const output = await tool.execute(
      input,
      context(() => grants++, registered),
    );
    expect(output).toEqual({ output: '3 passed, 1 failed', artifactIds: [artifact.id] });
    expect(grants).toBe(1);
    expect(registered).toEqual([artifact]);
    expect(operations).toEqual([input]);

    status = 'FAILED';
    const error = await tool
      .execute(
        input,
        context(() => grants++, registered),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PLAYWRIGHT_TESTS_FAILED' });
    expect((error as Error).message).toContain('3 passed, 1 failed');
    const unauthorized = { ...context(() => undefined, []), governedAction: undefined };
    await expect(tool.execute(input, unauthorized)).rejects.toMatchObject({
      code: 'ACTION_NOT_AUTHORIZED',
    });
  });

  it('maps execution-runtime refusals and requires HTTPS off loopback', async () => {
    expect(() => new ExecutionClient('http://exec.example.com')).toThrow(
      'EXECUTION_RUNTIME_HTTPS_REQUIRED',
    );
    const refused = new ExecutionClient('http://127.0.0.1:4500', async () =>
      Response.json({ error: 'GRANT_EXPIRED' }, { status: 403 }),
    );
    await expect(refused.execute(grant, { kind: 'file.read', path: 'x' })).rejects.toMatchObject({
      code: 'GRANT_EXPIRED',
    });
    const down = new ExecutionClient('http://127.0.0.1:4500', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(down.execute(grant, { kind: 'file.read', path: 'x' })).rejects.toMatchObject({
      code: 'EXECUTION_RUNTIME_UNAVAILABLE',
      retryable: true,
    });
  });
});
