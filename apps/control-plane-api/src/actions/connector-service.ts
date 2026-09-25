import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
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

type Row = Record<string, unknown>;
type Audit = (
  actorId: string,
  eventType: string,
  resourceType: string,
  resourceId: string,
  metadata: object,
  organizationId: string,
) => void;

const settingsSchema = z
  .object({
    authEmail: z.email().max(254).optional(),
    allowedProjects: z
      .array(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/))
      .max(50)
      .refine((keys) => new Set(keys).size === keys.length, 'duplicate project key'),
  })
  .strict();
const createSchema = z
  .object({
    provider: z.enum(connectorProviders),
    name: z.string().trim().min(1).max(120),
    baseUrl: z.string().max(300),
    secretRef: z.string().regex(secretReferencePattern),
    settings: settingsSchema,
  })
  .strict();

const privateSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * Organization connections to external systems (ADR 0012). Stores a secret *reference* only;
 * the value is resolved by the secret store at dispatch time and never enters the database.
 */
export class ConnectorService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
    private readonly options: { allowPrivateNetwork?: boolean } = {},
  ) {}

  list(actor: Actor): ConnectorConnection[] {
    this.structure.authorize(actor);
    return (
      this.db
        .prepare(
          'SELECT * FROM organization_connector_connections WHERE organization_id=? ORDER BY status, name COLLATE NOCASE, id',
        )
        .all(actor.organizationId) as Row[]
    ).map((row) => this.map(row));
  }

  create(actor: Actor, raw: unknown): ConnectorConnection {
    const input = createSchema.parse(raw);
    const baseUrl = this.normalizeUrl(input.baseUrl);
    this.structure.authorize(actor);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO organization_connector_connections (id,organization_id,provider,name,base_url,secret_ref,settings,
           status,version,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,'ACTIVE',1,?,?,?,?)`,
        )
        .run(
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
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE'))
        throw new OrganizationDomainError(409, 'CONNECTION_ALREADY_ACTIVE');
      throw error;
    }
    this.audit(
      actor.id,
      'connector.connection.created',
      'connector_connection',
      id,
      { provider: input.provider, name: input.name, secretRef: input.secretRef },
      actor.organizationId,
    );
    return this.get(actor.organizationId, id)!;
  }

  disable(actor: Actor, id: string, version: number): ConnectorConnection {
    this.structure.authorize(actor);
    const changed = this.db
      .prepare(
        `UPDATE organization_connector_connections SET status='DISABLED', version=version+1, updated_by=?, updated_at=?
         WHERE id=? AND organization_id=? AND status='ACTIVE' AND version=?`,
      )
      .run(actor.id, new Date().toISOString(), id, actor.organizationId, version);
    if (changed.changes !== 1) {
      if (!this.get(actor.organizationId, id))
        throw new OrganizationDomainError(404, 'CONNECTION_NOT_FOUND');
      throw new OrganizationDomainError(409, 'CONNECTION_VERSION_CONFLICT');
    }
    this.audit(
      actor.id,
      'connector.connection.disabled',
      'connector_connection',
      id,
      {},
      actor.organizationId,
    );
    return this.get(actor.organizationId, id)!;
  }

  /** The single active connection for a provider in a tenant, if any. */
  active(organizationId: string, provider: ConnectorProvider): ConnectorConnection | null {
    const row = this.db
      .prepare(
        `SELECT * FROM organization_connector_connections WHERE organization_id=? AND provider=? AND status='ACTIVE'`,
      )
      .get(organizationId, provider) as Row | undefined;
    return row ? this.map(row) : null;
  }

  get(organizationId: string, id: string): ConnectorConnection | null {
    const row = this.db
      .prepare('SELECT * FROM organization_connector_connections WHERE id=? AND organization_id=?')
      .get(id, organizationId) as Row | undefined;
    return row ? this.map(row) : null;
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
