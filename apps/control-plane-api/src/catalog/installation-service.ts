import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Actor, OrganizationAgentInstallation } from '@agents-foundry/contracts';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import type { CatalogService } from './catalog-service.js';

const name = z.string().trim().min(1).max(120);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const configuration = z.record(z.string().max(60), z.unknown());
const createInput = z
  .object({
    name,
    blueprintId: z.string().min(1).max(120),
    blueprintVersion: semver,
    configuration,
  })
  .strict();
const updateInput = z
  .object({
    name,
    blueprintVersion: semver,
    configuration,
    version: z.number().int().positive(),
  })
  .strict();
const listQuery = z
  .object({ status: z.enum(['ACTIVE', 'RETIRED', 'all']).default('ACTIVE') })
  .strict();

type Row = Record<string, unknown>;

/**
 * Organization installations of catalog blueprint versions (Phase B). Installation changes
 * apply only to agents created afterwards; issued manifests are never modified.
 */
export class InstallationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly catalog: CatalogService,
    private readonly structure: OrganizationStructureService,
  ) {}

  list(actor: Actor, query: unknown): OrganizationAgentInstallation[] {
    this.structure.authorize(actor);
    const { status } = listQuery.parse(query);
    const rows = this.db
      .prepare(
        `SELECT i.*, c.digest FROM organization_agent_installations i
         JOIN catalog_blueprint_versions c ON c.blueprint_id=i.blueprint_id AND c.version=i.blueprint_version
         WHERE i.organization_id=? AND (?='all' OR i.status=?) ORDER BY i.name COLLATE NOCASE, i.id`,
      )
      .all(actor.organizationId, status, status) as Row[];
    return rows.map((row) => this.map(row));
  }

  create(actor: Actor, raw: unknown): OrganizationAgentInstallation {
    const input = createInput.parse(raw);
    const bundle = this.catalog.bundle(input.blueprintId, input.blueprintVersion);
    const config = this.catalog.validateAnswers(bundle, input.configuration, 'INSTALLATION');
    return this.transaction(actor, () => {
      this.assertNameFree(actor.organizationId, input.name);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO organization_agent_installations (id,organization_id,name,blueprint_id,blueprint_version,
           configuration,status,version,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,'ACTIVE',1,?,?,?,?)`,
        )
        .run(
          id,
          actor.organizationId,
          input.name,
          input.blueprintId,
          input.blueprintVersion,
          JSON.stringify(config),
          actor.id,
          now,
          actor.id,
          now,
        );
      const created = this.get(actor.organizationId, id);
      this.audit(actor, 'agent_installation.created', id, null, created);
      return created;
    });
  }

  /** Change name, configuration or blueprint version (same blueprint) for future agents. */
  update(actor: Actor, id: string, raw: unknown): OrganizationAgentInstallation {
    const input = updateInput.parse(raw);
    return this.transaction(actor, () => {
      const before = this.get(actor.organizationId, id);
      if (before.status !== 'ACTIVE')
        throw new OrganizationDomainError(409, 'INSTALLATION_RETIRED');
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'VERSION_CONFLICT');
      const bundle = this.catalog.bundle(before.blueprintId, input.blueprintVersion);
      const config = this.catalog.validateAnswers(bundle, input.configuration, 'INSTALLATION');
      if (input.name.toLowerCase() !== before.name.toLowerCase())
        this.assertNameFree(actor.organizationId, input.name);
      this.db
        .prepare(
          `UPDATE organization_agent_installations SET name=?, blueprint_version=?, configuration=?,
           version=version+1, updated_by=?, updated_at=? WHERE id=? AND organization_id=? AND version=?`,
        )
        .run(
          input.name,
          input.blueprintVersion,
          JSON.stringify(config),
          actor.id,
          new Date().toISOString(),
          id,
          actor.organizationId,
          input.version,
        );
      const after = this.get(actor.organizationId, id);
      this.audit(actor, 'agent_installation.updated', id, before, after);
      return after;
    });
  }

  /** Retired installations cannot create agents; agents already created keep working. */
  retire(actor: Actor, id: string, version: number): OrganizationAgentInstallation {
    return this.transaction(actor, () => {
      const before = this.get(actor.organizationId, id);
      if (before.status !== 'ACTIVE')
        throw new OrganizationDomainError(409, 'INSTALLATION_RETIRED');
      if (before.version !== version) throw new OrganizationDomainError(409, 'VERSION_CONFLICT');
      this.db
        .prepare(
          `UPDATE organization_agent_installations SET status='RETIRED', version=version+1, updated_by=?, updated_at=?
           WHERE id=? AND organization_id=?`,
        )
        .run(actor.id, new Date().toISOString(), id, actor.organizationId);
      const after = this.get(actor.organizationId, id);
      this.audit(actor, 'agent_installation.retired', id, before, after);
      return after;
    });
  }

  /** The active installation an admin is creating agents from, in the actor's tenant only. */
  activeInstallation(organizationId: string, id: string): OrganizationAgentInstallation {
    const installation = this.get(organizationId, id);
    if (installation.status !== 'ACTIVE')
      throw new OrganizationDomainError(409, 'INSTALLATION_RETIRED');
    return installation;
  }

  private get(organizationId: string, id: string): OrganizationAgentInstallation {
    const row = this.db
      .prepare(
        `SELECT i.*, c.digest FROM organization_agent_installations i
         JOIN catalog_blueprint_versions c ON c.blueprint_id=i.blueprint_id AND c.version=i.blueprint_version
         WHERE i.id=? AND i.organization_id=?`,
      )
      .get(id, organizationId) as Row | undefined;
    if (!row) throw new OrganizationDomainError(404, 'INSTALLATION_NOT_FOUND');
    return this.map(row);
  }

  private assertNameFree(organizationId: string, value: string): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM organization_agent_installations WHERE organization_id=? AND status='ACTIVE'
           AND name=? COLLATE NOCASE`,
        )
        .get(organizationId, value)
    )
      throw new OrganizationDomainError(409, 'INSTALLATION_NAME_EXISTS');
  }

  private transaction<T>(actor: Actor, work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.structure.authorize(actor);
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private audit(actor: Actor, action: string, id: string, before: unknown, after: unknown): void {
    this.db
      .prepare('INSERT INTO organization_change_events VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        actor.organizationId,
        actor.id,
        action,
        'agent_installation',
        id,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        randomUUID(),
        new Date().toISOString(),
      );
  }

  private map(row: Row): OrganizationAgentInstallation {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      name: String(row['name']),
      blueprintId: String(row['blueprint_id']),
      blueprintVersion: String(row['blueprint_version']),
      blueprintDigest: String(row['digest']),
      configuration: JSON.parse(String(row['configuration'])) as Record<string, string | string[]>,
      status: String(row['status']) as OrganizationAgentInstallation['status'],
      version: Number(row['version']),
      createdBy: String(row['created_by']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }
}
