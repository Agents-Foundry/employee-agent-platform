import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactStoreError,
  LocalArtifactStore,
  MemoryArtifactStore,
  S3ArtifactStore,
  artifactStoreFromEnvironment,
  signObjectStoreRequest,
  type ArtifactStore,
} from '../src/artifacts/artifact-store.js';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const badKeys = [
  '',
  'single-segment',
  '/org/run/id',
  'org/run/id/',
  'org//id',
  'org/../other/id',
  'org/./id',
  'org/run/..',
  'org\\run\\id',
  'org/run/id?x=1',
  'org/run/%2e%2e',
  'org/run/a b',
  'C:/run/id',
];

describe('artifact stores (ADR 0033)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'af-artifacts-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('keeps, returns and removes objects, and refuses keys that could leave the store', async () => {
    for (const store of [
      new LocalArtifactStore(root),
      new MemoryArtifactStore(),
    ] as ArtifactStore[]) {
      const key = 'org_a/3d7e0e60-0000-4000-8000-000000000001/3d7e0e60-0000-4000-8000-000000000002';
      expect(await store.get(key)).toBeNull();
      await store.put(key, Buffer.from('evidence'), 'text/plain');
      expect((await store.get(key))!.toString()).toBe('evidence');
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
      // Removing what is already gone is not an error.
      await store.delete(key);
      for (const bad of badKeys) {
        await expect(store.put(bad, Buffer.from('x'), 'text/plain'), bad).rejects.toBeInstanceOf(
          ArtifactStoreError,
        );
        await expect(store.get(bad), bad).rejects.toBeInstanceOf(ArtifactStoreError);
        await expect(store.delete(bad), bad).rejects.toBeInstanceOf(ArtifactStoreError);
      }
    }
    // Nothing was written outside the store's own tree.
    expect(await readdir(root)).toEqual(['org_a']);
  });

  it('signs S3 requests exactly as AWS Signature Version 4 specifies', () => {
    // The GET Object example from the Amazon S3 API reference.
    const headers = signObjectStoreRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadSha256: sha256(''),
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers).not.toHaveProperty('host');
  });

  it('talks to an S3-compatible store with signed requests and no credentials in errors', async () => {
    const objects = new Map<string, Buffer>();
    const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
    let failing = false;
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'store-secret-key-value' };
    const fetch = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init!.headers as Record<string, string>;
      seen.push({ method: init!.method!, url: url.href, headers });
      expect(init!.redirect).toBe('error');
      if (failing)
        return new Response(
          `<Error><Code>AccessDenied</Code>${credentials.secretAccessKey}</Error>`,
          {
            status: 403,
          },
        );
      const body = init!.body ? Buffer.from(init!.body as Uint8Array) : Buffer.alloc(0);
      // What a real store checks: the declared payload hash and a signature over the request.
      expect(headers['x-amz-content-sha256']).toBe(sha256(body));
      expect(headers['authorization']).toBe(
        signObjectStoreRequest({
          method: init!.method!,
          url,
          headers: headers['content-type'] ? { 'content-type': headers['content-type'] } : {},
          payloadSha256: sha256(body),
          region: 'eu-west-1',
          credentials,
          now: new Date('2026-10-01T10:00:00Z'),
        })['authorization'],
      );
      if (init!.method === 'PUT') {
        objects.set(url.pathname, body);
        return new Response(null, { status: 200 });
      }
      if (init!.method === 'DELETE') {
        objects.delete(url.pathname);
        return new Response(null, { status: 204 });
      }
      const found = objects.get(url.pathname);
      return found ? new Response(new Uint8Array(found)) : new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    const store = new S3ArtifactStore({
      endpoint: 'https://objects.example.com',
      region: 'eu-west-1',
      bucket: 'af-artifacts',
      prefix: 'prod',
      credentials: () => credentials,
      fetch,
      now: () => new Date('2026-10-01T10:00:00Z'),
    });
    const key = 'org_a/run-1/artifact-1';
    await store.put(key, Buffer.from('trace'), 'application/zip');
    expect([...objects.keys()]).toEqual(['/af-artifacts/prod/org_a/run-1/artifact-1']);
    expect((await store.get(key))!.toString()).toBe('trace');
    expect(await store.get('org_a/run-1/missing')).toBeNull();
    await store.delete(key);
    expect(objects.size).toBe(0);
    await store.delete(key);
    // The secret key is used to sign and never sent.
    expect(JSON.stringify(seen)).not.toContain(credentials.secretAccessKey);
    for (const bad of badKeys)
      await expect(store.get(bad), bad).rejects.toBeInstanceOf(ArtifactStoreError);

    failing = true;
    for (const attempt of [
      () => store.put(key, Buffer.from('x'), 'text/plain'),
      () => store.get(key),
      () => store.delete(key),
    ]) {
      const error = await attempt().then(
        () => null,
        (caught: unknown) => caught as Error,
      );
      expect(error).toBeInstanceOf(ArtifactStoreError);
      expect(error!.message).toBe('ARTIFACT_STORE_UNAVAILABLE');
      expect(JSON.stringify(error)).not.toContain(credentials.secretAccessKey);
    }
    // A store that cannot be reached at all is reported the same way.
    const unreachable = new S3ArtifactStore({
      endpoint: 'https://objects.example.com',
      region: 'eu-west-1',
      bucket: 'af-artifacts',
      credentials: () => credentials,
      fetch: (async () => {
        throw new Error(`connect failed for ${credentials.secretAccessKey}`);
      }) as typeof globalThis.fetch,
    });
    await expect(unreachable.get(key)).rejects.toThrow('ARTIFACT_STORE_UNAVAILABLE');
  });

  it('configures the store from the environment and fails closed on bad settings', async () => {
    expect(artifactStoreFromEnvironment({ ARTIFACT_STORE_DIR: root }).name).toBe(
      'control-plane-local',
    );
    expect(() => artifactStoreFromEnvironment({ ARTIFACT_STORE: 'ftp' })).toThrow(
      'ARTIFACT_STORE_INVALID',
    );
    const s3 = {
      ARTIFACT_STORE: 's3',
      ARTIFACT_S3_ENDPOINT: 'https://storage.googleapis.com',
      ARTIFACT_S3_REGION: 'auto',
      ARTIFACT_S3_BUCKET: 'af-artifacts',
      ARTIFACT_S3_CREDENTIALS_PATH: join(root, 'credentials.json'),
    };
    for (const missing of Object.keys(s3).slice(1)) {
      const env = { ...s3, [missing]: '' };
      expect(() => artifactStoreFromEnvironment(env), missing).toThrow(`${missing}_REQUIRED`);
    }
    expect(() =>
      artifactStoreFromEnvironment({ ...s3, ARTIFACT_S3_ENDPOINT: 'http://objects.example.com' }),
    ).toThrow('ARTIFACT_STORE_HTTPS_REQUIRED');
    expect(() =>
      artifactStoreFromEnvironment({ ...s3, ARTIFACT_S3_BUCKET: 'Not A Bucket' }),
    ).toThrow('ARTIFACT_STORE_BUCKET_INVALID');
    // Credentials are read from the file on each request, so a missing or malformed file
    // stops requests instead of sending unsigned ones.
    const store = artifactStoreFromEnvironment(s3);
    expect(store.name).toBe('object-store');
    await expect(store.get('org_a/run/id')).rejects.toThrow('ARTIFACT_STORE_UNAVAILABLE');
    await writeFile(s3.ARTIFACT_S3_CREDENTIALS_PATH, '{"accessKeyId":"only"}');
    await expect(store.get('org_a/run/id')).rejects.toThrow('ARTIFACT_STORE_UNAVAILABLE');
  });
});
