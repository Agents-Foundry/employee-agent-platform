import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import {
  runtimeAuthHeaders,
  runtimeSigningInput,
} from '../../../packages/contracts/src/runtime/v1/transport.js';

export function runtimeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** One signed runtime request, exactly as `ControlPlaneClient` sends it. */
export function signedRuntimePost(
  app: Express,
  runtimeId: string,
  key: KeyObject,
  path: string,
  body?: unknown,
) {
  const text = body === undefined ? '' : JSON.stringify(body);
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
        bodySha256: createHash('sha256').update(text).digest('hex'),
      }),
    ),
    key,
  ).toString('base64');
  return request(app)
    .post(path)
    .set({
      'content-type': 'application/json',
      [runtimeAuthHeaders.runtimeId]: runtimeId,
      [runtimeAuthHeaders.timestamp]: timestamp,
      [runtimeAuthHeaders.nonce]: nonce,
      [runtimeAuthHeaders.signature]: signature,
    })
    .send(text);
}
