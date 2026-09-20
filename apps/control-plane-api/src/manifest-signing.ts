import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentManifestPayload,
  ManifestVerificationKey,
  SignedAgentManifest,
} from '@agents-foundry/contracts';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';

export class ManifestSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  readonly verificationKey: ManifestVerificationKey;

  constructor(privateKeyPem?: string) {
    this.privateKey = privateKeyPem
      ? createPrivateKey(privateKeyPem)
      : generateKeyPairSync('ed25519').privateKey;
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('ED25519_KEY_REQUIRED');
    this.publicKey = createPublicKey(this.privateKey);
    const der = this.publicKey.export({ type: 'spki', format: 'der' });
    this.verificationKey = {
      keyId: createHash('sha256').update(der).digest('hex'),
      algorithm: 'Ed25519',
      publicKeySpki: der.toString('base64'),
    };
  }

  static fromFile(path: string): ManifestSigner {
    try {
      return new ManifestSigner(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(path), { recursive: true });
    const key = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    try {
      writeFileSync(path, key, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return new ManifestSigner(readFileSync(path, 'utf8'));
  }

  sign(payload: AgentManifestPayload): SignedAgentManifest {
    const snapshot = structuredClone(payload);
    return {
      payload: snapshot,
      algorithm: 'Ed25519',
      keyId: this.verificationKey.keyId,
      signature: sign(null, Buffer.from(canonicalManifest(snapshot)), this.privateKey).toString(
        'base64',
      ),
    };
  }

  verify(manifest: SignedAgentManifest): boolean {
    try {
      return (
        manifest.algorithm === 'Ed25519' &&
        manifest.keyId === this.verificationKey.keyId &&
        verify(
          null,
          Buffer.from(canonicalManifest(manifest.payload)),
          this.publicKey,
          Buffer.from(manifest.signature, 'base64'),
        )
      );
    } catch {
      return false;
    }
  }
}
