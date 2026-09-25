import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  RUNTIME_REQUEST_MAX_SKEW_MS,
  runtimeAuthHeaders,
  runtimeSigningInput,
} from '../../../../packages/contracts/src/runtime/v1/transport.js';
import { ExecutionError } from '../execution/execution-service.js';

/**
 * Operator-provisioned workload identity of one agent runtime (ADR 0011). Only the public key
 * is held here; the control plane never stores a runtime secret.
 */
export interface RuntimeIdentity {
  id: string;
  publicKey: KeyObject;
  /** Tenants this runtime may serve; `'*'` is a platform-operated shared runtime. */
  organizations: '*' | ReadonlySet<string>;
  runtimeProfiles: ReadonlySet<string>;
}

const identitySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/),
    /** Base64 DER SubjectPublicKeyInfo of an Ed25519 key. */
    publicKeySpki: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(200),
    organizations: z
      .array(z.string().regex(/^(\*|[A-Za-z0-9_.:-]{1,120})$/))
      .min(1)
      .max(1000),
    runtimeProfiles: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/))
      .min(1)
      .max(50),
  })
  .strict();
const registrySchema = z.array(identitySchema).max(100);
export type RuntimeIdentityConfig = z.input<typeof identitySchema>;

export class RuntimeIdentityRegistry {
  private readonly identities = new Map<string, RuntimeIdentity>();

  constructor(configs: readonly RuntimeIdentityConfig[] = []) {
    const parsed = registrySchema.safeParse(configs);
    if (!parsed.success) throw new Error('RUNTIME_IDENTITY_CONFIG_INVALID');
    for (const config of parsed.data) {
      if (this.identities.has(config.id)) throw new Error('RUNTIME_IDENTITY_CONFIG_INVALID');
      const wildcard = config.organizations.includes('*');
      if (wildcard && config.organizations.length !== 1)
        throw new Error('RUNTIME_IDENTITY_CONFIG_INVALID');
      let publicKey: KeyObject;
      try {
        publicKey = createPublicKey({
          key: Buffer.from(config.publicKeySpki, 'base64'),
          format: 'der',
          type: 'spki',
        });
      } catch {
        throw new Error('RUNTIME_IDENTITY_CONFIG_INVALID');
      }
      if (publicKey.asymmetricKeyType !== 'ed25519')
        throw new Error('RUNTIME_IDENTITY_CONFIG_INVALID');
      this.identities.set(config.id, {
        id: config.id,
        publicKey,
        organizations: wildcard ? '*' : new Set(config.organizations),
        runtimeProfiles: new Set(config.runtimeProfiles),
      });
    }
  }

  /** `AGENT_RUNTIME_IDENTITIES_PATH` → JSON array. Unset means no runtime can authenticate. */
  static fromEnvironment(): RuntimeIdentityRegistry {
    const path = process.env['AGENT_RUNTIME_IDENTITIES_PATH'];
    if (!path) return new RuntimeIdentityRegistry();
    let configs: unknown;
    try {
      configs = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('RUNTIME_IDENTITY_CONFIG_INVALID');
    }
    return new RuntimeIdentityRegistry(configs as RuntimeIdentityConfig[]);
  }

  get size(): number {
    return this.identities.size;
  }

  get(id: string): RuntimeIdentity | undefined {
    return this.identities.get(id);
  }
}

export function servesOrganization(identity: RuntimeIdentity, organizationId: string): boolean {
  return identity.organizations === '*' || identity.organizations.has(organizationId);
}

export interface SignedRuntimeRequest {
  method: string;
  path: string;
  header: (name: string) => string | undefined;
  body: Buffer;
}

/**
 * Authenticate one signed runtime request. Every failure is the same 401 so callers learn
 * nothing about which check failed. `consumeNonce` must return false for a replayed nonce.
 */
export function authenticateRuntimeRequest(
  registry: RuntimeIdentityRegistry,
  request: SignedRuntimeRequest,
  consumeNonce: (runtimeId: string, nonce: string, expiresAt: number) => boolean,
  nowMs = Date.now(),
): RuntimeIdentity {
  const unauthenticated = () => new ExecutionError(401, 'RUNTIME_UNAUTHENTICATED');
  const runtimeId = request.header(runtimeAuthHeaders.runtimeId);
  const timestamp = request.header(runtimeAuthHeaders.timestamp);
  const nonce = request.header(runtimeAuthHeaders.nonce);
  const signature = request.header(runtimeAuthHeaders.signature);
  if (!runtimeId || !timestamp || !nonce || !signature) throw unauthenticated();
  const identity = registry.get(runtimeId);
  if (!identity) throw unauthenticated();
  if (!/^[0-9a-f-]{36}$/.test(nonce) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature))
    throw unauthenticated();
  const issuedAt = Date.parse(timestamp);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(timestamp) ||
    !Number.isFinite(issuedAt) ||
    Math.abs(nowMs - issuedAt) > RUNTIME_REQUEST_MAX_SKEW_MS
  )
    throw unauthenticated();
  const input = runtimeSigningInput({
    method: request.method,
    path: request.path,
    timestamp,
    nonce,
    bodySha256: createHash('sha256').update(request.body).digest('hex'),
  });
  let valid = false;
  try {
    valid = verify(null, Buffer.from(input), identity.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) throw unauthenticated();
  // Only a verified request may consume a nonce, so forged traffic cannot burn real nonces.
  if (!consumeNonce(identity.id, nonce, issuedAt + RUNTIME_REQUEST_MAX_SKEW_MS))
    throw unauthenticated();
  return identity;
}
