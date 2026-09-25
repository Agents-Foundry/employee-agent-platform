import type { KeySource, SignedAgentManifestV2 } from '@agents-foundry/contracts';
import { RuntimeFailure } from '../errors.js';

// Provider-neutral model types. Kernels speak these; provider adapters translate them.
// They are runtime-internal and never cross the runtime protocol (ADR 0006).

export type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelContent[];
}

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxTokens: number;
}

export interface ModelResponse {
  content: ModelContent[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Held only in memory for one call. Never logged, persisted, checkpointed or emitted. */
export interface ModelCredential {
  apiKey: string;
}

export interface ModelProvider {
  readonly id: string;
  complete(
    request: ModelRequest,
    credential: ModelCredential,
    signal: AbortSignal,
  ): Promise<ModelResponse>;
}

export interface CredentialScope {
  organizationId: string;
  employeeId: string;
  provider: string;
  credentialMode: KeySource;
}

/** Brokers short-lived or operator-held model credentials; the manifest carries only the mode. */
export interface CredentialBroker {
  resolve(scope: CredentialScope): Promise<ModelCredential>;
}

/**
 * ORGANIZATION_MANAGED credentials from operator environment (`AF_MODEL_API_KEY_<PROVIDER>`).
 * EMPLOYEE_BYOK keys live on the employee's device, so a server runtime cannot use them yet:
 * that mode fails closed rather than falling back to an organization key.
 */
export class EnvironmentCredentialBroker implements CredentialBroker {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(scope: CredentialScope): Promise<ModelCredential> {
    if (scope.credentialMode !== 'ORGANIZATION_MANAGED')
      throw new RuntimeFailure(
        'MODEL_CREDENTIAL_UNAVAILABLE',
        'Employee-held model keys are not available to a server runtime.',
      );
    const name = `AF_MODEL_API_KEY_${scope.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const apiKey = this.env[name];
    if (!apiKey)
      throw new RuntimeFailure(
        'MODEL_CREDENTIAL_UNAVAILABLE',
        `No organization-managed credential is configured for ${scope.provider}.`,
      );
    return { apiKey };
  }
}

/**
 * Routes a manifest's model selection to a registered provider. Roles request a profile and
 * a provider/model pinned at issuance; they never name an SDK. Unknown providers fail closed.
 */
export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    providers: readonly ModelProvider[],
    private readonly credentials: CredentialBroker,
  ) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  async complete(
    manifest: SignedAgentManifestV2,
    request: Omit<ModelRequest, 'model'>,
    signal: AbortSignal,
  ): Promise<{ response: ModelResponse; latencyMs: number }> {
    const { model, metadata } = manifest.payload;
    const provider = this.providers.get(model.provider);
    if (!provider)
      throw new RuntimeFailure(
        'MODEL_PROVIDER_UNAVAILABLE',
        `Model provider ${model.provider} is not available in this runtime.`,
      );
    const credential = await this.credentials.resolve({
      organizationId: metadata.organizationId,
      employeeId: metadata.employeeId,
      provider: model.provider,
      credentialMode: model.credentialMode,
    });
    const started = Date.now();
    const response = await provider.complete(
      { ...request, model: model.model },
      credential,
      signal,
    );
    return { response, latencyMs: Date.now() - started };
  }
}
