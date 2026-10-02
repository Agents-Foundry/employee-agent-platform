import { z } from 'zod';
import type { Actor, ModelCredentialBinding } from '@agents-foundry/contracts';
import { secretReferencePattern } from '../../../../packages/contracts/src/actions.js';
import type { Audit } from '../actions/action-policy-service.js';
import type { PgStore, Row } from '../db/pg-store.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import { SecretUnavailable, type SecretBroker, type SecretValue } from './secret-broker.js';

const providerPattern = /^[a-zA-Z0-9._-]{1,80}$/;
const bindingSchema = z
  .object({
    secretRef: z.string().regex(secretReferencePattern),
    /** The version being replaced; omitted when the provider has no binding yet. */
    version: z.number().int().positive().optional(),
  })
  .strict();

/** Why a run cannot be given a model credential. Codes never contain a secret. */
export class ModelCredentialRefused extends Error {
  constructor(
    readonly code:
      | 'MODEL_CREDENTIAL_UNAVAILABLE'
      | 'MODEL_PROVIDER_MISMATCH'
      | 'MODEL_CREDENTIAL_NOT_CONFIGURED'
      | 'SECRET_UNRESOLVED',
  ) {
    super(code);
  }
}

/**
 * Organization-managed model credentials (ADR 0034). PostgreSQL holds a `secret://` reference
 * per organization and provider; the secret broker turns it into the key only for the runtime
 * holding a running run whose signed manifest names that provider and that credential mode.
 * Employee-held keys never pass through here: that mode fails closed.
 */
export class ModelCredentialService {
  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly secrets: Pick<SecretBroker, 'resolve'>,
    private readonly audit: Audit,
  ) {}

  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return work();
    });
  }

  list(actor: Actor): Promise<ModelCredentialBinding[]> {
    return this.asAdmin(actor, async () =>
      (
        await this.db.all(
          'SELECT * FROM organization_model_credentials WHERE organization_id=? ORDER BY provider',
          actor.organizationId,
        )
      ).map(mapBinding),
    );
  }

  /** Point a provider at a secret reference. Replacing an existing binding needs its version. */
  set(actor: Actor, provider: string, raw: unknown): Promise<ModelCredentialBinding> {
    if (!providerPattern.test(provider))
      throw new OrganizationDomainError(400, 'MODEL_PROVIDER_INVALID');
    const input = bindingSchema.parse(raw);
    return this.asAdmin(actor, async () => {
      const now = new Date().toISOString();
      const existing = await this.row(actor.organizationId, provider);
      if (!existing) {
        if (input.version !== undefined)
          throw new OrganizationDomainError(409, 'MODEL_CREDENTIAL_VERSION_CONFLICT');
        await this.db.run(
          `INSERT INTO organization_model_credentials (organization_id,provider,secret_ref,status,version,
           created_by,created_at,updated_by,updated_at) VALUES (?,?,?,'ACTIVE',1,?,?,?,?)`,
          actor.organizationId,
          provider,
          input.secretRef,
          actor.id,
          now,
          actor.id,
          now,
        );
      } else {
        const changed = await this.db.run(
          `UPDATE organization_model_credentials SET secret_ref=?, status='ACTIVE', version=version+1,
           updated_by=?, updated_at=? WHERE organization_id=? AND provider=? AND version=?`,
          input.secretRef,
          actor.id,
          now,
          actor.organizationId,
          provider,
          input.version ?? -1,
        );
        if (changed.changes !== 1)
          throw new OrganizationDomainError(409, 'MODEL_CREDENTIAL_VERSION_CONFLICT');
      }
      await this.audit(
        actor.id,
        'model_credential.set',
        'model_credential',
        provider,
        { provider, secretRef: input.secretRef },
        actor.organizationId,
      );
      return mapBinding((await this.row(actor.organizationId, provider))!);
    });
  }

  disable(actor: Actor, provider: string, version: number): Promise<ModelCredentialBinding> {
    return this.asAdmin(actor, async () => {
      const changed = await this.db.run(
        `UPDATE organization_model_credentials SET status='DISABLED', version=version+1, updated_by=?,
         updated_at=? WHERE organization_id=? AND provider=? AND version=? AND status='ACTIVE'`,
        actor.id,
        new Date().toISOString(),
        actor.organizationId,
        provider,
        version,
      );
      if (changed.changes !== 1) {
        if (!(await this.row(actor.organizationId, provider)))
          throw new OrganizationDomainError(404, 'MODEL_CREDENTIAL_NOT_FOUND');
        throw new OrganizationDomainError(409, 'MODEL_CREDENTIAL_VERSION_CONFLICT');
      }
      await this.audit(
        actor.id,
        'model_credential.disabled',
        'model_credential',
        provider,
        { provider },
        actor.organizationId,
      );
      return mapBinding((await this.row(actor.organizationId, provider))!);
    });
  }

  /**
   * The organization's key for `provider`, for a run already checked to be running and held
   * by the asking runtime. `model` comes from the run's signed manifest. Every refusal and
   * every issue is audited without the key.
   */
  async forRun(
    run: { organizationId: string; runId: string; agentId: string },
    model: { provider: string; credentialMode: string },
    requestedProvider: string,
    runtimeId: string,
  ): Promise<SecretValue> {
    const refuse = async (code: ModelCredentialRefused['code']) => {
      await this.audit(
        runtimeId,
        'runtime.model.credential.refused',
        'agent_run',
        run.runId,
        { provider: requestedProvider, code },
        run.organizationId,
      );
      return new ModelCredentialRefused(code);
    };
    // Employee-held keys stay on the employee's device (ADR 0034): nothing to give.
    if (model.credentialMode !== 'ORGANIZATION_MANAGED')
      throw await refuse('MODEL_CREDENTIAL_UNAVAILABLE');
    if (model.provider !== requestedProvider) throw await refuse('MODEL_PROVIDER_MISMATCH');
    const binding = await this.db.tenant(run.organizationId, () =>
      this.row(run.organizationId, requestedProvider),
    );
    if (!binding || binding['status'] !== 'ACTIVE')
      throw await refuse('MODEL_CREDENTIAL_NOT_CONFIGURED');
    let secret: SecretValue;
    try {
      secret = await this.secrets.resolve(run.organizationId, String(binding['secret_ref']));
    } catch (error) {
      if (!(error instanceof SecretUnavailable)) throw error;
      throw await refuse('SECRET_UNRESOLVED');
    }
    await this.audit(
      runtimeId,
      'runtime.model.credential.issued',
      'agent_run',
      run.runId,
      { provider: requestedProvider, agentId: run.agentId },
      run.organizationId,
    );
    return secret;
  }

  private row(organizationId: string, provider: string): Promise<Row | undefined> {
    return this.db.get(
      'SELECT * FROM organization_model_credentials WHERE organization_id=? AND provider=?',
      organizationId,
      provider,
    );
  }
}

function mapBinding(row: Row): ModelCredentialBinding {
  return {
    provider: String(row['provider']),
    secretRef: String(row['secret_ref']),
    status: String(row['status']) as ModelCredentialBinding['status'],
    version: Number(row['version']),
    updatedAt: String(row['updated_at']),
    updatedBy: String(row['updated_by']),
  };
}
