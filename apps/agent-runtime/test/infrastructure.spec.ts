import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runtimeAuthHeaders,
  runtimeSigningInput,
} from '../../../packages/contracts/src/runtime/v1/transport.js';
import { FileCheckpointStore } from '../src/checkpoints.js';
import { ControlPlaneError, RuntimeFailure } from '../src/errors.js';
import { AnthropicProvider } from '../src/models/anthropic-provider.js';
import { LocalArtifactStore } from '../src/tools/artifact-store.js';
import { ControlPlaneClient } from '../src/transport/control-plane-client.js';
import { correlation, signedManifest } from './fixtures.js';

describe('control-plane client', () => {
  it('signs method, path, timestamp, nonce and body digest with the workload key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seen: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const client = new ControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4100',
      runtimeId: 'runtime-x',
      privateKey,
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          headers: init!.headers as Record<string, string>,
          body: Buffer.from(init!.body as Uint8Array),
        });
        return new Response(null, { status: 204 });
      },
    });
    expect(await client.claim()).toBeNull();
    const [call] = seen;
    expect(call!.url).toBe('http://127.0.0.1:4100/runtime/v1/commands/claim');
    const headers = call!.headers;
    expect(headers[runtimeAuthHeaders.runtimeId]).toBe('runtime-x');
    const input = runtimeSigningInput({
      method: 'POST',
      path: '/runtime/v1/commands/claim',
      timestamp: headers[runtimeAuthHeaders.timestamp]!,
      nonce: headers[runtimeAuthHeaders.nonce]!,
      bodySha256: createHash('sha256').update(call!.body).digest('hex'),
    });
    expect(
      verify(
        null,
        Buffer.from(input),
        publicKey,
        Buffer.from(headers[runtimeAuthHeaders.signature]!, 'base64'),
      ),
    ).toBe(true);
  });

  it('refuses plaintext remote control planes and surfaces rejections as final errors', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(
      () =>
        new ControlPlaneClient({ baseUrl: 'http://cp.example.com', runtimeId: 'x', privateKey }),
    ).toThrow('CONTROL_PLANE_HTTPS_REQUIRED');
    expect(
      () =>
        new ControlPlaneClient({
          baseUrl: 'https://cp.example.com',
          runtimeId: 'x',
          privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
        }),
    ).toThrow('RUNTIME_KEY_ED25519_REQUIRED');
    const client = new ControlPlaneClient({
      baseUrl: 'https://cp.example.com',
      runtimeId: 'x',
      privateKey,
      fetch: async () => Response.json({ error: 'RUNTIME_LEASE_REQUIRED' }, { status: 403 }),
    });
    const error = await client.claim().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({ status: 403, code: 'RUNTIME_LEASE_REQUIRED', final: true });
    const malformed = new ControlPlaneClient({
      baseUrl: 'https://cp.example.com',
      runtimeId: 'x',
      privateKey,
      fetch: async () => Response.json({ command: { type: 'run.submit' }, lease: {} }),
    });
    await expect(malformed.claim()).rejects.toThrow('RUNTIME_RESPONSE_INVALID');
  });
});

describe('model provider adapter', () => {
  it('maps the Anthropic Messages API without leaking the key or response body on errors', async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const provider = new AnthropicProvider('https://api.example.test', async (_url, init) => {
      body = JSON.parse(String(init!.body));
      headers = init!.headers as Record<string, string>;
      return Response.json({
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'artifact', input: { a: 1 } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    });
    const response = await provider.complete(
      {
        model: 'claude-test',
        system: 'sys',
        maxTokens: 100,
        tools: [{ name: 'artifact', description: 'd', inputSchema: { type: 'object' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't0', name: 'artifact', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 't0', content: 'ok', isError: false }],
          },
        ],
      },
      { apiKey: 'secret-key' },
      new AbortController().signal,
    );
    expect(headers['x-api-key']).toBe('secret-key');
    expect(body).toMatchObject({
      model: 'claude-test',
      max_tokens: 100,
      tools: [{ name: 'artifact', input_schema: { type: 'object' } }],
    });
    expect((body['messages'] as { content: unknown[] }[])[2]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't0',
      content: 'ok',
      is_error: false,
    });
    expect(response).toEqual({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'artifact', input: { a: 1 } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    const failing = new AnthropicProvider(
      'https://api.example.test',
      async () => new Response('{"error":"echo secret-key"}', { status: 529 }),
    );
    const error = await failing
      .complete(
        { model: 'm', system: '', maxTokens: 1, tools: [], messages: [] },
        { apiKey: 'secret-key' },
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeFailure);
    expect(error).toMatchObject({ code: 'MODEL_REQUEST_FAILED', retryable: true });
    expect((error as Error).message).not.toContain('secret-key');
  });
});

describe('runtime local state', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'af-runtime-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores artifacts under opaque references and rejects path escapes', async () => {
    const store = new LocalArtifactStore(root);
    const stored = await store.put({
      organizationId: 'org_a',
      runId: 'run-1',
      artifactId: 'artifact-1',
      name: 'report.md',
      content: Buffer.from('# Report'),
    });
    expect(stored).toEqual({
      storageReference: 'artifact://local-runtime/org_a/run-1/artifact-1/report.md',
      checksum: createHash('sha256').update('# Report').digest('hex'),
      sizeBytes: 8,
    });
    expect(await readFile(join(root, 'org_a', 'run-1', 'artifact-1', 'report.md'), 'utf8')).toBe(
      '# Report',
    );
    for (const name of ['../x', '..', 'a/b', '']) {
      await expect(
        store.put({
          organizationId: 'org_a',
          runId: 'run-1',
          artifactId: 'artifact-2',
          name,
          content: Buffer.from('x'),
        }),
      ).rejects.toThrow('ARTIFACT_KEY_INVALID');
    }
    await expect(
      store.put({
        organizationId: 'org_a',
        runId: 'run-1',
        artifactId: 'artifact-1',
        name: 'report.md',
        content: Buffer.from('y'),
      }),
    ).rejects.toThrow();
  });

  it('round-trips checkpoints atomically and rejects non-UUID run ids', async () => {
    const store = new FileCheckpointStore(root);
    const subject = correlation();
    const checkpoint = {
      version: 1 as const,
      runId: subject.runId,
      sessionId: subject.threadId,
      correlation: subject,
      task: { objective: 'x', inputs: {} },
      runtimeProfile: 'standard-agent',
      manifest: signedManifest(subject),
      kernelId: 'native-v1',
      kernelState: { any: 'thing' },
      approvalId: subject.threadId,
    };
    await store.save(checkpoint);
    expect(await store.load(subject.runId)).toEqual(checkpoint);
    expect(await readdir(root)).toEqual([`${subject.runId}.json`]);
    await store.delete(subject.runId);
    expect(await store.load(subject.runId)).toBeNull();
    await expect(store.load('../../etc/passwd')).rejects.toThrow('RUN_ID_INVALID');
  });
});

describe('architecture boundaries', () => {
  it('imports only contracts from the monorepo, never control-plane code or agent frameworks', async () => {
    const source = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    await walk(source);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        const allowed =
          specifier.startsWith('node:') ||
          specifier === 'zod' ||
          specifier === '@agents-foundry/contracts' ||
          specifier.startsWith('./') ||
          (specifier.startsWith('../') &&
            !specifier.includes('apps/') &&
            (!specifier.includes('packages/') || specifier.includes('packages/contracts/')));
        expect(allowed, `${relative(source, file)} imports ${specifier}`).toBe(true);
      }
    }
  });
});
