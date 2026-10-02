import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Where artifact bytes live (ADR 0033). Only the control plane talks to a store, with the
 * store's own credentials; runtimes, agents and workspaces never see them. Keys are chosen by
 * the control plane and always start with the tenant: a store is never asked for a key that a
 * request supplied.
 */
export interface ArtifactStore {
  /** The `<store>` of `artifact://<store>/<key>` references to objects kept here. */
  readonly name: string;
  put(key: string, content: Buffer, mediaType: string): Promise<void>;
  /** The object's bytes, or null if there is none. */
  get(key: string): Promise<Buffer | null>;
  /** Removes the object. Removing one that is already gone succeeds. */
  delete(key: string): Promise<void>;
  /**
   * A request that stores exactly these bytes at `key` and nothing else (ADR 0037): the key,
   * size, SHA-256 and media type are all covered by the signature, and it stops working within
   * minutes. Stores that cannot issue one leave this out; the control plane then receives the
   * bytes itself.
   */
  authorizePut?(
    key: string,
    upload: { mediaType: string; sizeBytes: number; sha256: string },
  ): { url: string; headers: Record<string, string>; expiresAt: string };
}

/** How long the store accepts a signed request after it was signed (the SigV4 limit). */
export const STORE_SIGNATURE_WINDOW_MS = 15 * 60_000;

export class ArtifactStoreError extends Error {
  constructor(readonly code: 'ARTIFACT_KEY_INVALID' | 'ARTIFACT_STORE_UNAVAILABLE') {
    super(code);
  }
}

const keyPattern = /^[A-Za-z0-9._-]{1,120}(?:\/[A-Za-z0-9._-]{1,120}){1,7}$/;

/** Keys are plain path segments: no traversal, no empty or dot segments. */
export function assertArtifactKey(key: string): void {
  if (
    !keyPattern.test(key) ||
    key.split('/').some((segment) => segment === '.' || segment === '..')
  )
    throw new ArtifactStoreError('ARTIFACT_KEY_INVALID');
}

/** Development adapter: files under one directory on the control plane's host. */
export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(
    root: string,
    readonly name = 'control-plane-local',
  ) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertArtifactKey(key);
    const path = join(this.root, ...key.split('/'));
    if (!path.startsWith(this.root + sep)) throw new ArtifactStoreError('ARTIFACT_KEY_INVALID');
    return path;
  }

  async put(key: string, content: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** Keeps objects in memory (tests). */
export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, Buffer>();

  constructor(readonly name = 'memory-store') {}

  async put(key: string, content: Buffer): Promise<void> {
    assertArtifactKey(key);
    this.objects.set(key, Buffer.from(content));
  }

  async get(key: string): Promise<Buffer | null> {
    assertArtifactKey(key);
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    assertArtifactKey(key);
    this.objects.delete(key);
  }
}

export interface ObjectStoreCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const hex = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest();
const encodeSegment = (segment: string) =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * AWS Signature Version 4 for one S3 request. Returns the headers to send, including
 * `authorization`. Every header given is signed.
 */
export function signObjectStoreRequest(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadSha256: string;
  region: string;
  credentials: ObjectStoreCredentials;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
    ),
    host: input.url.host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': amzDate,
    ...(input.credentials.sessionToken
      ? { 'x-amz-security-token': input.credentials.sessionToken }
      : {}),
  };
  const names = Object.keys(headers).sort();
  const query = [...input.url.searchParams.entries()]
    .map(([name, value]) => `${encodeSegment(name)}=${encodeSegment(value)}`)
    .sort()
    .join('&');
  const canonical = [
    input.method.toUpperCase(),
    input.url.pathname
      .split('/')
      .map((segment) => encodeSegment(decodeURIComponent(segment)))
      .join('/'),
    query,
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    names.join(';'),
    input.payloadSha256,
  ].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(
    (current, part) => hmac(current, part),
    hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, date), input.region),
  );
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`,
  };
}

export interface ObjectStoreOptions {
  /** For example `https://s3.eu-west-1.amazonaws.com` or `https://storage.googleapis.com`. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix inside the bucket, without leading or trailing slash. */
  prefix?: string;
  /** Read on every request, so rotated or short-lived credentials are picked up. */
  credentials: () => ObjectStoreCredentials;
  name?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Production adapter boundary: an S3-compatible object store (Amazon S3, Google Cloud Storage
 * through its interoperability API, MinIO), addressed path-style over HTTPS. The bucket is
 * private; nothing is ever made public and no object URL leaves the control plane.
 */
export class S3ArtifactStore implements ArtifactStore {
  readonly name: string;
  private readonly base: URL;

  constructor(private readonly options: ObjectStoreOptions) {
    this.name = options.name ?? 'object-store';
    this.base = new URL(options.endpoint);
    if (
      this.base.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)
    )
      throw new Error('ARTIFACT_STORE_HTTPS_REQUIRED');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket))
      throw new Error('ARTIFACT_STORE_BUCKET_INVALID');
    if (options.prefix !== undefined) assertArtifactKey(`${options.prefix}/x`);
  }

  private url(key: string): URL {
    assertArtifactKey(key);
    const path = [this.options.bucket, this.options.prefix, key].filter(Boolean).join('/');
    return new URL(`/${path}`, this.base);
  }

  /**
   * The headers of one `PUT`: the payload hash, length and type are signed, so the store
   * rejects any other bytes, and the signature names this key only. The store's secret key
   * stays here; the signature expires on the store's clock.
   */
  authorizePut(key: string, upload: { mediaType: string; sizeBytes: number; sha256: string }) {
    if (!/^[a-f0-9]{64}$/.test(upload.sha256) || !Number.isSafeInteger(upload.sizeBytes))
      throw new ArtifactStoreError('ARTIFACT_KEY_INVALID');
    const url = this.url(key);
    const now = this.options.now?.() ?? new Date();
    let credentials: ObjectStoreCredentials;
    try {
      credentials = this.options.credentials();
    } catch {
      throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
    }
    const headers = signObjectStoreRequest({
      method: 'PUT',
      url,
      headers: { 'content-type': upload.mediaType, 'content-length': String(upload.sizeBytes) },
      payloadSha256: upload.sha256,
      region: this.options.region,
      credentials,
      now,
    });
    return {
      url: url.href,
      headers,
      expiresAt: new Date(now.getTime() + STORE_SIGNATURE_WINDOW_MS).toISOString(),
    };
  }

  private async send(method: string, key: string, body?: Buffer, mediaType?: string) {
    const url = this.url(key);
    const headers = signObjectStoreRequest({
      method,
      url,
      headers: mediaType ? { 'content-type': mediaType } : {},
      payloadSha256: hex(body ?? ''),
      region: this.options.region,
      credentials: this.options.credentials(),
      now: this.options.now?.() ?? new Date(),
    });
    try {
      return await (this.options.fetch ?? fetch)(url, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch {
      // Never repeat a store error: it could name the bucket or echo a header.
      throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
    }
  }

  async put(key: string, content: Buffer, mediaType: string): Promise<void> {
    const response = await this.send('PUT', key, content, mediaType);
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.send('GET', key);
    if (response.status === 404) {
      await response.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key);
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok && response.status !== 404)
      throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
  }
}

/**
 * `ARTIFACT_STORE=local` (the default) keeps objects under `ARTIFACT_STORE_DIR`. `s3` uses an
 * S3-compatible store: `ARTIFACT_S3_ENDPOINT`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_BUCKET`,
 * optional `ARTIFACT_S3_PREFIX`, and `ARTIFACT_S3_CREDENTIALS_PATH`, a JSON file with
 * `accessKeyId`, `secretAccessKey` and optionally `sessionToken`, as a workload identity or
 * secrets agent writes it. The credentials are never read from the environment itself.
 */
export function artifactStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env): ArtifactStore {
  const kind = env['ARTIFACT_STORE']?.trim() || 'local';
  if (kind === 'local')
    return new LocalArtifactStore(env['ARTIFACT_STORE_DIR']?.trim() || '.data/artifacts');
  if (kind !== 's3') throw new Error('ARTIFACT_STORE_INVALID');
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name}_REQUIRED`);
    return value;
  };
  const credentialsPath = required('ARTIFACT_S3_CREDENTIALS_PATH');
  const prefix = env['ARTIFACT_S3_PREFIX']?.trim();
  return new S3ArtifactStore({
    endpoint: required('ARTIFACT_S3_ENDPOINT'),
    region: required('ARTIFACT_S3_REGION'),
    bucket: required('ARTIFACT_S3_BUCKET'),
    ...(prefix ? { prefix } : {}),
    credentials: () => {
      let parsed: Partial<ObjectStoreCredentials>;
      try {
        parsed = JSON.parse(readFileSync(credentialsPath, 'utf8')) as typeof parsed;
      } catch {
        throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
      }
      if (typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string')
        throw new ArtifactStoreError('ARTIFACT_STORE_UNAVAILABLE');
      return {
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
        ...(typeof parsed.sessionToken === 'string' ? { sessionToken: parsed.sessionToken } : {}),
      };
    },
  });
}
