import type { AnySignedAgentManifest, ManifestVerificationKey } from '@agents-foundry/contracts';
import {
  canonicalManifest,
  isSupportedManifestVersion,
  manifestSubject,
} from '../../../../packages/contracts/src/manifest.js';

/** Verifies v1 and v2 signed manifests (ADR 0004); unknown versions fail closed. */
export async function verifyManifest(
  manifest: AnySignedAgentManifest,
  key: ManifestVerificationKey,
  expected: { agentId: string; employeeId: string; organizationId: string },
): Promise<boolean> {
  try {
    if (!isSupportedManifestVersion(manifest.payload.apiVersion)) return false;
    const subject = manifestSubject(manifest.payload);
    if (
      manifest.algorithm !== 'Ed25519' ||
      key.algorithm !== 'Ed25519' ||
      manifest.keyId !== key.keyId ||
      subject.agentId !== expected.agentId ||
      subject.employeeId !== expected.employeeId ||
      subject.organizationId !== expected.organizationId
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
