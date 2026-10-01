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
  ExecutionGrantPayload,
  SignedExecutionGrant,
  AnyAgentManifestPayload,
  AnySignedAgentManifest,
  ManifestVerificationKey,
  SignedManifest,
} from '@agents-foundry/contracts';
import {
  canonicalManifest,
  isSupportedManifestVersion,
} from '../../../packages/contracts/src/manifest.js';
import { executionGrantSigningInput } from '../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { webhookSigningInput } from '../../../packages/contracts/src/webhooks.js';

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

  /** Signs v1 and v2 payloads identically (ADR 0004); the version is part of the signed bytes. */
  sign<P extends AnyAgentManifestPayload>(payload: P): SignedManifest<P> {
    if (!isSupportedManifestVersion(payload.apiVersion)) throw new Error('MANIFEST_INVALID');
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

  /** Execution grants share the key but sign a domain-separated input (ADR 0013). */
  signExecutionGrant(payload: ExecutionGrantPayload): SignedExecutionGrant {
    const snapshot = structuredClone(payload);
    return {
      payload: snapshot,
      algorithm: 'Ed25519',
      keyId: this.verificationKey.keyId,
      signature: sign(
        null,
        Buffer.from(executionGrantSigningInput(snapshot)),
        this.privateKey,
      ).toString('base64'),
    };
  }

  /** Whether this signer issued `grant` unchanged (credential redemption, ADR 0031). */
  verifyExecutionGrant(grant: SignedExecutionGrant): boolean {
    try {
      return (
        grant.algorithm === 'Ed25519' &&
        grant.keyId === this.verificationKey.keyId &&
        verify(
          null,
          Buffer.from(executionGrantSigningInput(grant.payload)),
          this.publicKey,
          Buffer.from(grant.signature, 'base64'),
        )
      );
    } catch {
      return false;
    }
  }

  /** Webhook deliveries share the key but sign a domain-separated input (ADR 0024). */
  signWebhook(deliveryId: string, timestamp: number, body: string): string {
    return sign(
      null,
      Buffer.from(webhookSigningInput(deliveryId, timestamp, body)),
      this.privateKey,
    ).toString('base64');
  }

  verify(manifest: AnySignedAgentManifest): boolean {
    try {
      return (
        isSupportedManifestVersion(manifest.payload.apiVersion) &&
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
