import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  CredentialReleaseOutcome,
  RepositoryCredential,
  SignedExecutionGrant,
} from '@agents-foundry/contracts';
import { credentialTransportPaths } from '../../../packages/contracts/src/credentials.js';
import { parseCredentialRedeemResponse } from '../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import {
  runtimeAuthHeaders,
  runtimeSigningInput,
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

export interface ControlPlaneCredentialClientOptions {
  controlPlaneUrl: string;
  runtimeId: string;
  privateKey: KeyObject;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ControlPlaneCredentialClient implements CredentialSource {
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

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    const signature = sign(
      null,
      Buffer.from(
        runtimeSigningInput({
          method: 'POST',
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
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [runtimeAuthHeaders.runtimeId]: this.options.runtimeId,
          [runtimeAuthHeaders.timestamp]: timestamp,
          [runtimeAuthHeaders.nonce]: nonce,
          [runtimeAuthHeaders.signature]: signature,
        },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15_000)]),
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
