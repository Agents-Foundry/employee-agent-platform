import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  ArtifactUpload,
  ArtifactUploadDescriptor,
  CredentialReleaseOutcome,
  RepositoryCredential,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import {
  parseArtifactUpload,
  parseArtifactUploadAuthorization,
} from '../../../packages/contracts/src/runtime/v1/schemas.js';
import { directUploadMediaTypes } from '../../../packages/contracts/src/artifacts.js';
import { credentialTransportPaths } from '../../../packages/contracts/src/credentials.js';
import { parseCredentialRedeemResponse } from '../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import {
  runtimeAuthHeaders,
  runtimeSigningInput,
  runtimeTransportPaths,
} from '../../../packages/contracts/src/runtime/v1/transport.js';

/** A refusal or failure from the control plane. The code never contains a credential. */
export class CredentialRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A redeemed credential. It is never logged or serialized; read it with `reveal()`. */
export class CheckoutCredential {
  readonly #credential: RepositoryCredential;

  constructor(
    credential: RepositoryCredential,
    readonly expiresAt: number,
  ) {
    this.#credential = credential;
  }

  reveal(): RepositoryCredential {
    return this.#credential;
  }

  /** Every form the credential could take in output, for redaction. */
  secrets(): string[] {
    const { username, password } = this.#credential;
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    return [password, basic, encodeURIComponent(password)];
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}

/**
 * How this execution runtime redeems and releases repository credential leases (ADR 0031). It
 * authenticates to the control plane with its own Ed25519 workload identity, which the control
 * plane registers with the `execution` role; it never sees an agent runtime's key.
 */
export interface CredentialSource {
  redeem(
    grant: SignedExecutionGrant,
    leaseId: string,
    signal: AbortSignal,
  ): Promise<CheckoutCredential>;
  release(leaseId: string, grantId: string, outcome: CredentialReleaseOutcome): Promise<void>;
}

/**
 * Stores evidence of a granted operation in the control plane's artifact store (ADR 0033).
 * The signed grant is the authorization; this runtime holds no object-store credentials.
 */
export interface EvidenceUploader {
  upload(
    grant: SignedExecutionGrant,
    artifact: ArtifactUploadDescriptor,
    content: Buffer,
  ): Promise<ArtifactUpload>;
}

export interface ControlPlaneCredentialClientOptions {
  controlPlaneUrl: string;
  runtimeId: string;
  privateKey: KeyObject;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Artifacts larger than this are uploaded directly to the artifact store (ADR 0037) when
   * their media type allows it; smaller ones travel inside the signed request.
   */
  directUploadThresholdBytes?: number;
}

/** Above this, base64 inside a JSON request stops being practical. */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024;

export class ControlPlaneCredentialClient implements CredentialSource, EvidenceUploader {
  private readonly base: URL;

  constructor(private readonly options: ControlPlaneCredentialClientOptions) {
    this.base = new URL(options.controlPlaneUrl);
    if (options.privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('EXECUTION_IDENTITY_ED25519_REQUIRED');
  }

  /**
   * `EXECUTION_CONTROL_PLANE_URL`, `EXECUTION_RUNTIME_ID` and `EXECUTION_RUNTIME_KEY_PATH`
   * (PKCS#8 PEM). Unset means authenticated checkouts are refused.
   */
  static fromEnvironment(): ControlPlaneCredentialClient | undefined {
    const url = process.env['EXECUTION_CONTROL_PLANE_URL']?.trim();
    const id = process.env['EXECUTION_RUNTIME_ID']?.trim();
    const keyPath = process.env['EXECUTION_RUNTIME_KEY_PATH']?.trim();
    if (!url && !id && !keyPath) return undefined;
    if (!url || !id || !keyPath) throw new Error('EXECUTION_RUNTIME_IDENTITY_INCOMPLETE');
    return new ControlPlaneCredentialClient({
      controlPlaneUrl: url,
      runtimeId: id,
      privateKey: createPrivateKey(readFileSync(keyPath)),
    });
  }

  async redeem(
    grant: SignedExecutionGrant,
    leaseId: string,
    signal: AbortSignal,
  ): Promise<CheckoutCredential> {
    const body = await this.post(credentialTransportPaths.redeem, { leaseId, grant }, signal);
    let parsed;
    try {
      parsed = parseCredentialRedeemResponse(body);
    } catch {
      throw new CredentialRefused('CREDENTIAL_RESPONSE_INVALID');
    }
    if (parsed.leaseId !== leaseId) throw new CredentialRefused('CREDENTIAL_RESPONSE_INVALID');
    return new CheckoutCredential(parsed.credential, Date.parse(parsed.expiresAt));
  }

  async release(
    leaseId: string,
    grantId: string,
    outcome: CredentialReleaseOutcome,
  ): Promise<void> {
    await this.post(
      credentialTransportPaths.release,
      { leaseId, grantId, outcome },
      AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    );
  }

  async upload(
    grant: SignedExecutionGrant,
    artifact: ArtifactUploadDescriptor,
    content: Buffer,
  ): Promise<ArtifactUpload> {
    const timeoutMs = this.options.uploadTimeoutMs ?? 120_000;
    const direct =
      content.byteLength >
        (this.options.directUploadThresholdBytes ?? DIRECT_UPLOAD_THRESHOLD_BYTES) &&
      (directUploadMediaTypes as readonly string[]).includes(artifact.mediaType);
    const body = direct
      ? await this.uploadDirectly(grant, artifact, content, timeoutMs)
      : await this.post(
          runtimeTransportPaths.artifactUploadExecution,
          { grant, artifact, content: content.toString('base64') },
          AbortSignal.timeout(timeoutMs),
          timeoutMs,
        );
    let stored: ArtifactUpload;
    try {
      stored = parseArtifactUpload(body);
    } catch {
      throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
    }
    if (
      stored.artifactId !== artifact.id ||
      stored.checksum.value !== artifact.checksum.value ||
      stored.sizeBytes !== artifact.sizeBytes
    )
      throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
    return stored;
  }

  /**
   * Ask for permission to store exactly these bytes, send them where the permission says,
   * then have the control plane read them back and accept them. The permission is a
   * signature for one object; this runtime never holds a store credential.
   */
  private async uploadDirectly(
    grant: SignedExecutionGrant,
    artifact: ArtifactUploadDescriptor,
    content: Buffer,
    timeoutMs: number,
  ): Promise<unknown> {
    let permission;
    try {
      permission = parseArtifactUploadAuthorization(
        await this.post(
          runtimeTransportPaths.artifactUploadAuthorize,
          { grant, artifact },
          AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        ),
      );
    } catch (error) {
      if (error instanceof CredentialRefused) throw error;
      throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
    }
    if (permission.artifactId !== artifact.id)
      throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
    if (permission.target === 'CONTROL_PLANE') {
      // Only ever this control plane's own upload path.
      if (!permission.url.startsWith(`${runtimeTransportPaths.artifactContent}/`))
        throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
      await this.send(
        'PUT',
        permission.url,
        content,
        artifact.mediaType,
        AbortSignal.timeout(timeoutMs),
        timeoutMs,
      );
    } else {
      let target: URL;
      try {
        target = new URL(permission.url);
      } catch {
        throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
      }
      if (
        target.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      )
        throw new CredentialRefused('ARTIFACT_RESPONSE_INVALID');
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(target, {
          method: 'PUT',
          headers: permission.headers,
          body: new Uint8Array(content),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer().catch(() => undefined);
      } catch {
        throw new CredentialRefused('ARTIFACT_STORE_UNREACHABLE');
      }
      // Never repeat what the store answered: it could name the bucket or echo a header.
      if (!response.ok) throw new CredentialRefused('ARTIFACT_STORE_REFUSED');
    }
    return this.post(
      runtimeTransportPaths.artifactUploadComplete,
      { grant, artifactId: artifact.id },
      AbortSignal.timeout(timeoutMs),
      timeoutMs,
    );
  }

  private post(
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? 15_000,
  ): Promise<unknown> {
    return this.send(
      'POST',
      path,
      Buffer.from(JSON.stringify(body), 'utf8'),
      'application/json',
      signal,
      timeoutMs,
    );
  }

  /** One request signed with this runtime's workload key; the signature covers the body. */
  private async send(
    method: 'POST' | 'PUT',
    path: string,
    bytes: Buffer,
    contentType: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const signature = sign(
      null,
      Buffer.from(
        runtimeSigningInput({
          method,
          path,
          timestamp,
          nonce,
          bodySha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      ),
      this.options.privateKey,
    ).toString('base64');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(new URL(path, this.base), {
        method,
        headers: {
          'content-type': contentType,
          [runtimeAuthHeaders.runtimeId]: this.options.runtimeId,
          [runtimeAuthHeaders.timestamp]: timestamp,
          [runtimeAuthHeaders.nonce]: nonce,
          [runtimeAuthHeaders.signature]: signature,
        },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      throw new CredentialRefused('CONTROL_PLANE_UNREACHABLE');
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = (parsed as { error?: unknown } | null)?.error;
      throw new CredentialRefused(
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
          ? code
          : `HTTP_${response.status}`,
      );
    }
    return parsed;
  }
}
