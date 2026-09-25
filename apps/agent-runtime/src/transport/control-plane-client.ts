import { createHash, randomUUID, sign, type KeyObject } from 'node:crypto';
import type {
  RuntimeActionDecision,
  RuntimeActionExecuteRequest,
  RuntimeActionExecution,
  RuntimeActionRequest,
  RuntimeClaimResponse,
  RuntimeEventAck,
  RuntimeEventEnvelope,
} from '@agents-foundry/contracts';
import {
  runtimeAuthHeaders,
  runtimeSigningInput,
  runtimeTransportPaths,
} from '../../../../packages/contracts/src/runtime/v1/transport.js';
import {
  parseRuntimeActionDecision,
  parseRuntimeActionExecution,
  parseRuntimeClaimResponse,
} from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import { ControlPlaneError } from '../errors.js';

/** The runtime's view of the control plane; tests substitute an in-memory implementation. */
export interface ControlPlanePort {
  claim(): Promise<RuntimeClaimResponse | null>;
  sendEvent(event: RuntimeEventEnvelope): Promise<RuntimeEventAck>;
  requestAction(request: RuntimeActionRequest): Promise<RuntimeActionDecision>;
  executeAction(request: RuntimeActionExecuteRequest): Promise<RuntimeActionExecution>;
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  runtimeId: string;
  /** Ed25519 workload key. Only its public half is registered with the control plane. */
  privateKey: KeyObject;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Signed HTTP client for the runtime transport (ADR 0011). Every request carries a fresh nonce,
 * a timestamp and an Ed25519 signature over the method, path and body digest.
 */
export class ControlPlaneClient implements ControlPlanePort {
  private readonly base: URL;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ControlPlaneClientOptions) {
    if (options.privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('RUNTIME_KEY_ED25519_REQUIRED');
    this.base = new URL(options.baseUrl);
    if (
      this.base.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)
    )
      throw new Error('CONTROL_PLANE_HTTPS_REQUIRED');
    this.fetch = options.fetch ?? fetch;
  }

  async claim(): Promise<RuntimeClaimResponse | null> {
    const response = await this.post(runtimeTransportPaths.claim, undefined);
    return response === null ? null : parseRuntimeClaimResponse(response);
  }

  async sendEvent(event: RuntimeEventEnvelope): Promise<RuntimeEventAck> {
    return (await this.post(runtimeTransportPaths.events, event)) as RuntimeEventAck;
  }

  async requestAction(request: RuntimeActionRequest): Promise<RuntimeActionDecision> {
    return parseRuntimeActionDecision(await this.post(runtimeTransportPaths.actions, request));
  }

  async executeAction(request: RuntimeActionExecuteRequest): Promise<RuntimeActionExecution> {
    return parseRuntimeActionExecution(await this.post(runtimeTransportPaths.execute, request));
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
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
    const response = await this.fetch(new URL(path, this.base), {
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
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = (parsed as { error?: unknown } | null)?.error;
      throw new ControlPlaneError(
        response.status,
        typeof code === 'string' ? code : `HTTP_${response.status}`,
      );
    }
    return parsed;
  }
}
