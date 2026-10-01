import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import { secretReferencePattern } from '../../../../packages/contracts/src/actions.js';
import {
  credentialModes,
  sourceControlProviders,
  type SourceControlConnection,
} from '../../../../packages/contracts/src/credentials.js';
import { hostname } from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import { constraintKind, type PgStore, type Row } from '../db/pg-store.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import type { Audit } from '../actions/action-policy-service.js';
import { repositoryNamePattern, repositoryOf, sameRepositoryName } from './source-control.js';

const unique = (values: string[]) =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length;

const createSchema = z
  .object({
    provider: z.enum(sourceControlProviders),
    name: z.string().trim().min(1).max(120),
    gitHost: hostname,
    apiBaseUrl: z.string().max(300),
    credentialMode: z.enum(credentialModes),
    secretRef: z.string().regex(secretReferencePattern),
    appId: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
    installationId: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
    allowedRepositories: z
      .array(z.string().regex(repositoryNamePattern))
      .min(1)
      .max(100)
      .refine(unique, 'duplicate repository'),
  })
  .strict()
  .refine(
    (input) =>
      input.credentialMode === 'github_app'
        ? input.provider === 'github' && !!input.appId && !!input.installationId
        : !input.appId && !input.installationId,
    'GitHub App connections need appId and installationId; token connections take neither',
  );

const privateSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test'];

/**
 * Organization connections to source-control hosts (ADR 0031). Each stores a secret
 * reference and the repositories checkouts may authenticate to; only its status changes after
 * creation. Administrators manage them; the credential broker reads them.
 */
export class SourceControlConnectionService {
  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
    private readonly options: { allowPrivateNetwork?: boolean } = {},
  ) {}

  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return work();
    });
  }

  list(actor: Actor): Promise<SourceControlConnection[]> {
    return this.asAdmin(actor, async () =>
      (
        await this.db.all(
          'SELECT * FROM organization_source_control_connections WHERE organization_id=? ORDER BY status, lower(name), id',
          actor.organizationId,
        )
      ).map(mapConnection),
    );
  }

  async create(actor: Actor, raw: unknown): Promise<SourceControlConnection> {
    const input = createSchema.parse(raw);
    this.checkHost(input.gitHost);
    const apiBaseUrl = this.normalizeApiUrl(input.apiBaseUrl);
    try {
      return await this.asAdmin(actor, async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await this.db.run(
          `INSERT INTO organization_source_control_connections (id,organization_id,provider,name,git_host,
           api_base_url,credential_mode,secret_ref,app_id,installation_id,allowed_repositories,status,version,
           created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',1,?,?,?,?)`,
          id,
          actor.organizationId,
          input.provider,
          input.name,
          input.gitHost,
          apiBaseUrl,
          input.credentialMode,
          input.secretRef,
          input.appId ?? null,
          input.installationId ?? null,
          JSON.stringify(input.allowedRepositories),
          actor.id,
          now,
          actor.id,
          now,
        );
        await this.audit(
          actor.id,
          'source_control.connection.created',
          'source_control_connection',
          id,
          {
            provider: input.provider,
            gitHost: input.gitHost,
            credentialMode: input.credentialMode,
            secretRef: input.secretRef,
            repositories: input.allowedRepositories.length,
          },
          actor.organizationId,
        );
        return (await this.get(actor.organizationId, id))!;
      });
    } catch (error) {
      if (constraintKind(error) === 'unique')
        throw new OrganizationDomainError(409, 'CONNECTION_ALREADY_ACTIVE');
      throw error;
    }
  }

  disable(actor: Actor, id: string, version: number): Promise<SourceControlConnection> {
    return this.asAdmin(actor, async () => {
      const changed = await this.db.run(
        `UPDATE organization_source_control_connections SET status='DISABLED', version=version+1,
         updated_by=?, updated_at=? WHERE id=? AND organization_id=? AND status='ACTIVE' AND version=?`,
        actor.id,
        new Date().toISOString(),
        id,
        actor.organizationId,
        version,
      );
      if (changed.changes !== 1) {
        if (!(await this.get(actor.organizationId, id)))
          throw new OrganizationDomainError(404, 'CONNECTION_NOT_FOUND');
        throw new OrganizationDomainError(409, 'CONNECTION_VERSION_CONFLICT');
      }
      await this.audit(
        actor.id,
        'source_control.connection.disabled',
        'source_control_connection',
        id,
        {},
        actor.organizationId,
      );
      return (await this.get(actor.organizationId, id))!;
    });
  }

  /** Caller's tenant transaction. */
  async get(organizationId: string, id: string): Promise<SourceControlConnection | null> {
    const row = await this.db.get(
      'SELECT * FROM organization_source_control_connections WHERE id=? AND organization_id=?',
      id,
      organizationId,
    );
    return row ? mapConnection(row) : null;
  }

  /**
   * The active connection that authenticates checkouts of `repositoryUrl`, and the repository
   * it names; null when no active connection for its host allows it (caller's transaction).
   */
  async forRepository(
    organizationId: string,
    repositoryUrl: string,
  ): Promise<{ connection: SourceControlConnection; repository: string } | null> {
    let host: string;
    try {
      host = new URL(repositoryUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
    const row = await this.db.get(
      `SELECT * FROM organization_source_control_connections
       WHERE organization_id=? AND git_host=? AND status='ACTIVE'`,
      organizationId,
      host,
    );
    if (!row) return null;
    const connection = mapConnection(row);
    const repository = repositoryOf(repositoryUrl, connection.gitHost);
    if (!repository) return null;
    const allowed = connection.allowedRepositories.find((name) =>
      sameRepositoryName(name, repository),
    );
    return allowed ? { connection, repository: allowed } : null;
  }

  private checkHost(host: string): void {
    if (
      !this.options.allowPrivateNetwork &&
      (isIP(host) !== 0 || privateSuffixes.some((suffix) => host.endsWith(suffix)))
    )
      throw new OrganizationDomainError(400, 'CONNECTION_HOST_INVALID');
  }

  /** HTTPS origin and path with a DNS name only; no credentials, query or fragment. */
  private normalizeApiUrl(value: string): string {
    const invalid = () => new OrganizationDomainError(400, 'CONNECTION_URL_INVALID');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['https:', 'http:'].includes(url.protocol) ||
      (!this.options.allowPrivateNetwork && url.protocol !== 'https:')
    )
      throw invalid();
    this.checkHost(url.hostname.toLowerCase());
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }
}

export function mapConnection(row: Row): SourceControlConnection {
  return {
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    provider: String(row['provider']) as SourceControlConnection['provider'],
    name: String(row['name']),
    gitHost: String(row['git_host']),
    apiBaseUrl: String(row['api_base_url']),
    credentialMode: String(row['credential_mode']) as SourceControlConnection['credentialMode'],
    secretRef: String(row['secret_ref']),
    ...(row['app_id'] ? { appId: String(row['app_id']) } : {}),
    ...(row['installation_id'] ? { installationId: String(row['installation_id']) } : {}),
    allowedRepositories: JSON.parse(String(row['allowed_repositories'])) as string[],
    status: String(row['status']) as SourceControlConnection['status'],
    version: Number(row['version']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}
