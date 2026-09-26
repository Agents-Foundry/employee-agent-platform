import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { ExecutionOperation, SignedExecutionGrant } from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import { executionGrantSigningInput } from '../../../packages/contracts/src/execution-runtime/v1/protocol.js';

export class GrantRejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const CLOCK_SKEW_MS = 30_000;

/**
 * Verifies control-plane execution grants against the pinned control-plane key. The grant is
 * the only authority: signature, expiry and the exact operation digest must all match.
 */
export class GrantVerifier {
  private readonly publicKey: KeyObject;
  readonly keyId: string;

  constructor(publicKeySpkiBase64: string) {
    const der = Buffer.from(publicKeySpkiBase64, 'base64');
    this.publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (this.publicKey.asymmetricKeyType !== 'ed25519')
      throw new Error('GRANT_KEY_ED25519_REQUIRED');
    this.keyId = createHash('sha256').update(der).digest('hex');
  }

  verify(grant: SignedExecutionGrant, operation: ExecutionOperation, nowMs = Date.now()): void {
    let valid = false;
    try {
      valid =
        grant.algorithm === 'Ed25519' &&
        grant.keyId === this.keyId &&
        verify(
          null,
          Buffer.from(executionGrantSigningInput(grant.payload)),
          this.publicKey,
          Buffer.from(grant.signature, 'base64'),
        );
    } catch {
      valid = false;
    }
    if (!valid) throw new GrantRejected('GRANT_INVALID');
    const issuedAt = Date.parse(grant.payload.issuedAt);
    const expiresAt = Date.parse(grant.payload.expiresAt);
    if (!(issuedAt <= nowMs + CLOCK_SKEW_MS) || !(nowMs < expiresAt))
      throw new GrantRejected('GRANT_EXPIRED');
    const digest = createHash('sha256').update(canonicalManifest(operation)).digest('hex');
    if (operation.kind !== grant.payload.operationKind || digest !== grant.payload.operationDigest)
      throw new GrantRejected('GRANT_OPERATION_MISMATCH');
  }
}
