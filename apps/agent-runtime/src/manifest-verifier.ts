import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { RuntimeCorrelation, SignedAgentManifestV2 } from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import { parseSignedManifest } from '../../../packages/contracts/src/runtime/v1/schemas.js';
import { RuntimeFailure } from './errors.js';

/**
 * Verifies signed v2 manifests against the control plane's manifest key, which is pinned in
 * runtime configuration rather than fetched, so a compromised transport cannot substitute it.
 */
export class ManifestVerifier {
  private readonly publicKey: KeyObject;
  readonly keyId: string;

  constructor(publicKeySpkiBase64: string) {
    const der = Buffer.from(publicKeySpkiBase64, 'base64');
    this.publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (this.publicKey.asymmetricKeyType !== 'ed25519')
      throw new Error('MANIFEST_KEY_ED25519_REQUIRED');
    this.keyId = createHash('sha256').update(der).digest('hex');
  }

  /** Fails closed: wrong version, key, signature, subject or runtime profile → MANIFEST_INVALID. */
  verify(
    manifest: unknown,
    expected: { correlation: RuntimeCorrelation; runtimeProfile: string },
  ): SignedAgentManifestV2 {
    const invalid = (reason: string) => new RuntimeFailure('MANIFEST_INVALID', reason);
    let parsed;
    try {
      parsed = parseSignedManifest(manifest);
    } catch {
      throw invalid('The manifest is malformed.');
    }
    if (parsed.payload.apiVersion !== 'agents-foundry/v2')
      throw invalid('Only agents-foundry/v2 manifests can be executed.');
    const signed = parsed as SignedAgentManifestV2;
    let valid = false;
    try {
      valid =
        signed.algorithm === 'Ed25519' &&
        signed.keyId === this.keyId &&
        verify(
          null,
          Buffer.from(canonicalManifest(signed.payload)),
          this.publicKey,
          Buffer.from(signed.signature, 'base64'),
        );
    } catch {
      valid = false;
    }
    if (!valid) throw invalid('The manifest signature is not valid for the pinned key.');
    const { metadata, runtime } = signed.payload;
    const { correlation } = expected;
    if (
      metadata.organizationId !== correlation.organizationId ||
      metadata.employeeId !== correlation.employeeId ||
      metadata.agentId !== correlation.agentId
    )
      throw invalid('The manifest subject does not match the run.');
    if (runtime.profile !== expected.runtimeProfile)
      throw invalid('The manifest runtime profile does not match the run.');
    return signed;
  }
}
