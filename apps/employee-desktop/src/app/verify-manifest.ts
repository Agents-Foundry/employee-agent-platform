import type { ManifestVerificationKey, SignedAgentManifest } from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';

export async function verifyManifest(
  manifest: SignedAgentManifest,
  key: ManifestVerificationKey,
  expected: { agentId: string; employeeId: string; organizationId: string },
): Promise<boolean> {
  try {
    if (
      manifest.algorithm !== 'Ed25519' ||
      key.algorithm !== 'Ed25519' ||
      manifest.keyId !== key.keyId ||
      manifest.payload.apiVersion !== 'agents-foundry/v1' ||
      manifest.payload.agentId !== expected.agentId ||
      manifest.payload.employeeId !== expected.employeeId ||
      manifest.payload.organizationId !== expected.organizationId
    )
      return false;
    const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const der = decode(key.publicKeySpki);
    const fingerprint = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', der)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (fingerprint !== key.keyId) return false;
    const publicKey = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      decode(manifest.signature),
      new TextEncoder().encode(canonicalManifest(manifest.payload)),
    );
  } catch {
    return false;
  }
}
