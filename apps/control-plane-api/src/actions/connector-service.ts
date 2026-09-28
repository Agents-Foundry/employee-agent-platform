import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Actor, ConnectorConnection, ConnectorProvider } from '@agents-foundry/contracts';
import {
  connectorProviders,
  secretReferencePattern,
} from '../../../../packages/contracts/src/actions.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import { constraintKind, type PgStore, type Row } from '../db/pg-store.js';
import type { Audit } from './action-policy-service.js';

const unique = (values: string[]) => new Set(values).size === values.length;
const jiraSettings = z
  .object({
    authEmail: z.email().max(254).optional(),
    allowedProjects: z
      .array(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/))
      .max(50)
      .refine(unique, 'duplicate project key'),
  })
  .strict();
/** GitHub (Phase G): repositories as `owner/name`. Stored with an empty project list. */
const githubSettings = z
  .object({
    allowedRepositories: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/))
      .max(50)
      .refine((names) => unique(names.map((name) => name.toLowerCase())), 'duplicate repository'),
  })
  .strict()
  .transform((settings) => ({ allowedProjects: [] as string[], ...settings }));
const common = {
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().max(300),
  secretRef: z.string().regex(secretReferencePattern),
};
const createSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('jira'), ...common, settings: jiraSettings }).strict(),
  z.object({ provider: z.literal('github'), ...common, settings: githubSettings }).strict(),
]) satisfies z.ZodType<{ provider: (typeof connectorProviders)[number] }>;

const privateSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * Organization connections to external systems (ADR 0012). Stores a secret *reference* only;
 * the value is resolved by the secret store at dispatch time and never enters the database.
 */
export class ConnectorService {
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

  list(actor: Actor): Promise<ConnectorConnection[]> {
    return this.asAdmin(actor, async () =>
      (
        await this.db.all(
          'SELECT * FROM organization_connector_connections WHERE organization_id=? ORDER BY status, lower(name), id',
          actor.organizationId,
        )
      ).map((row) => this.map(row)),
    );
  }

  async create(actor: Actor, raw: unknown): Promise<ConnectorConnection> {
    const input = createSchema.parse(raw);
    const baseUrl = this.normalizeUrl(input.baseUrl);
    try {
      return await this.asAdmin(actor, async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        await this.db.run(
          `INSERT INTO organization_connector_connections (id,organization_id,provider,name,base_url,secret_ref,settings,
           status,version,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,'ACTIVE',1,?,?,?,?)`,
          id,
          actor.organizationId,
          input.provider,
          input.name,
          baseUrl,
          input.secretRef,
          JSON.stringify(input.settings),
          actor.id,
          now,
          actor.id,
          now,
        );
        await this.audit(
          actor.id,
          'connector.connection.created',
          'connector_connection',
          id,
          { provider: input.provider, name: input.name, secretRef: input.secretRef },
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

  disable(actor: Actor, id: string, version: number): Promise<ConnectorConnection> {
    return this.asAdmin(actor, async () => {
      const changed = await this.db.run(
        `UPDATE organization_connector_connections SET status='DISABLED', version=version+1, updated_by=?, updated_at=?
         WHERE id=? AND organization_id=? AND status='ACTIVE' AND version=?`,
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
        'connector.connection.disabled',
        'connector_connection',
        id,
        {},
        actor.organizationId,
      );
      return (await this.get(actor.organizationId, id))!;
    });
  }

  /** The single active connection for a provider in a tenant, if any. */
  active(organizationId: string, provider: ConnectorProvider): Promise<ConnectorConnection | null> {
    return this.db.tenant(organizationId, async () => {
      const row = await this.db.get(
        `SELECT * FROM organization_connector_connections WHERE organization_id=? AND provider=? AND status='ACTIVE'`,
        organizationId,
        provider,
      );
      return row ? this.map(row) : null;
    });
  }

  get(organizationId: string, id: string): Promise<ConnectorConnection | null> {
    return this.db.tenant(organizationId, async () => {
      const row = await this.db.get(
        'SELECT * FROM organization_connector_connections WHERE id=? AND organization_id=?',
        id,
        organizationId,
      );
      return row ? this.map(row) : null;
    });
  }

  /**
   * HTTPS origins with a DNS name only: no credentials, query, fragment, IP literals or
   * private-looking names, which limits server-side request forgery from admin input.
   */
  private normalizeUrl(value: string): string {
    const invalid = () => new OrganizationDomainError(400, 'CONNECTION_URL_INVALID');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateHost =
      isIP(host) !== 0 ||
      host === 'localhost' ||
      !host.includes('.') ||
      privateSuffixes.some((suffix) => host.endsWith(suffix));
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!this.options.allowPrivateNetwork && (url.protocol !== 'https:' || privateHost)) ||
      !['https:', 'http:'].includes(url.protocol)
    )
      throw invalid();
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  private map(row: Row): ConnectorConnection {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      provider: String(row['provider']) as ConnectorProvider,
      name: String(row['name']),
      baseUrl: String(row['base_url']),
      secretRef: String(row['secret_ref']),
      settings: JSON.parse(String(row['settings'])) as ConnectorConnection['settings'],
      status: String(row['status']) as ConnectorConnection['status'],
      version: Number(row['version']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }
}
