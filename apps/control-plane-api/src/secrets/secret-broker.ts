import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { secretReferencePattern } from '../../../../packages/contracts/src/actions.js';
import type { SecretResolver } from '../actions/secrets.js';

const REDACTED = '[REDACTED]';

/**
 * A resolved secret (ADR 0031). It cannot be printed, logged or serialized by accident:
 * `String()`, `JSON.stringify` and `util.inspect` all yield `[REDACTED]`. The value is read
 * only through `reveal()`, at the single place that hands it to a provider.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('SECRET_EMPTY');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Why a secret could not be resolved. Never contains the value or provider responses. */
export class SecretUnavailable extends Error {
  constructor(readonly code: 'SECRET_REFERENCE_INVALID' | 'SECRET_UNRESOLVED') {
    super(code);
  }
}

/**
 * Where secret values live. Implementations scope every name to its organization, never log
 * values, and return null when the secret does not exist. Infrastructure failures throw; the
 * broker turns both into `SECRET_UNRESOLVED`, so callers fail closed either way.
 */
export interface SecretProvider {
  readonly id: string;
  resolve(organizationId: string, name: string, signal?: AbortSignal): Promise<string | null>;
}

/**
 * The single way the control plane reads secrets (ADR 0031). PostgreSQL stores only
 * `secret://<name>` references; values are resolved at the moment of use, per organization,
 * and returned as `SecretValue`.
 */
export class SecretBroker {
  constructor(private readonly provider: SecretProvider) {}

  get providerId(): string {
    return this.provider.id;
  }

  async resolve(
    organizationId: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<SecretValue> {
    if (!organizationId || !secretReferencePattern.test(reference))
      throw new SecretUnavailable('SECRET_REFERENCE_INVALID');
    let value: string | null;
    try {
      value = await this.provider.resolve(
        organizationId,
        reference.slice('secret://'.length),
        signal,
      );
    } catch {
      throw new SecretUnavailable('SECRET_UNRESOLVED');
    }
    if (typeof value !== 'string' || value.length === 0)
      throw new SecretUnavailable('SECRET_UNRESOLVED');
    return new SecretValue(value);
  }
}

/**
 * Development provider: the existing operator file or in-memory store (`CONNECTOR_SECRETS_PATH`).
 * Not for production; values sit in a plain file on the API host.
 */
export class DevelopmentSecretProvider implements SecretProvider {
  readonly id = 'development';

  constructor(private readonly store: SecretResolver) {}

  async resolve(organizationId: string, name: string): Promise<string | null> {
    return this.store.resolve(organizationId, `secret://${name}`);
  }
}

export interface VaultSecretProviderOptions {
  /** Vault origin, for example `https://vault.internal:8200`. HTTPS unless `allowHttp`. */
  address: string;
  /** KV version 2 mount, for example `agents-foundry`. */
  mount: string;
  /** Returns the current Vault token (from a file kept fresh by a Vault agent sidecar). */
  token: () => string;
  /** Path prefix under the mount; each organization gets `<prefix>/<organizationId>/<name>`. */
  prefix?: string;
  /** Vault Enterprise namespace. */
  namespace?: string;
  allowHttp?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const pathSegment = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * Production boundary: HashiCorp Vault (or a compatible KMS-backed store) KV version 2. Each
 * secret is a KV entry whose `value` field holds the secret. The control plane authenticates
 * with a short-lived token supplied by the platform (a Vault agent sidecar or workload
 * identity), so no long-lived Vault credential is stored by the API. Errors never include
 * response bodies.
 */
export class VaultSecretProvider implements SecretProvider {
  readonly id = 'vault';
  private readonly base: URL;

  constructor(private readonly options: VaultSecretProviderOptions) {
    const base = new URL(options.address);
    if (base.protocol !== 'https:' && !(options.allowHttp && base.protocol === 'http:'))
      throw new Error('VAULT_ADDRESS_INVALID');
    if (base.username || base.password || base.search || base.hash)
      throw new Error('VAULT_ADDRESS_INVALID');
    if (!pathSegment.test(options.mount) || (options.prefix && !pathSegment.test(options.prefix)))
      throw new Error('VAULT_PATH_INVALID');
    this.base = base;
  }

  async resolve(
    organizationId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!pathSegment.test(organizationId) || !pathSegment.test(name))
      throw new Error('VAULT_PATH_INVALID');
    const path = [this.options.mount, 'data', this.options.prefix, organizationId, name]
      .filter((segment): segment is string => !!segment)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = new URL(`/v1/${path}`, this.base);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 5000);
    const response = await (this.options.fetch ?? fetch)(url, {
      method: 'GET',
      headers: {
        'X-Vault-Token': this.options.token(),
        ...(this.options.namespace ? { 'X-Vault-Namespace': this.options.namespace } : {}),
      },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`VAULT_HTTP_${response.status}`);
    const body = (await response.json()) as { data?: { data?: { value?: unknown } } };
    const value = body.data?.data?.value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

/**
 * The configured provider: Vault when `SECRET_PROVIDER=vault`, otherwise the development
 * file store. An unknown provider name refuses to start.
 */
export function secretProviderFromEnvironment(development: SecretResolver): SecretProvider {
  const kind = process.env['SECRET_PROVIDER'] ?? 'development';
  if (kind === 'development') return new DevelopmentSecretProvider(development);
  if (kind !== 'vault') throw new Error('SECRET_PROVIDER_UNKNOWN');
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name}_REQUIRED`);
    return value;
  };
  const tokenPath = required('VAULT_TOKEN_PATH');
  return new VaultSecretProvider({
    address: required('VAULT_ADDR'),
    mount: required('VAULT_KV_MOUNT'),
    ...(process.env['VAULT_KV_PREFIX'] ? { prefix: process.env['VAULT_KV_PREFIX'] } : {}),
    ...(process.env['VAULT_NAMESPACE'] ? { namespace: process.env['VAULT_NAMESPACE'] } : {}),
    // Read on each use so a sidecar can rotate the token without a restart.
    token: () => readFileSync(tokenPath, 'utf8').trim(),
  });
}
