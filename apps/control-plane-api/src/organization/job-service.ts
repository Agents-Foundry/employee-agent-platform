import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import { jobKinds, type JobKind, type JobRecord } from '../../../../packages/contracts/src/jobs.js';
import type { Page } from '../../../../packages/contracts/src/organization.js';
import { OrganizationDomainError, type OrganizationStructureService } from './structure-service.js';

const uuid = z.string().uuid();
const base = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/),
    description: z.string().trim().max(2000).default(''),
  })
  .strict();
const schemas = {
  families: base,
  disciplines: base.extend({ jobFamilyId: uuid }),
  roles: base.extend({ jobFamilyId: uuid, disciplineId: uuid }),
  levels: base.extend({ rank: z.number().int().min(0).max(10000) }),
  positions: base.extend({
    organizationalUnitId: uuid,
    roleId: uuid,
    jobLevelId: uuid,
    reportsToPositionId: uuid.nullable(),
  }),
};
const tables: Record<JobKind, string> = {
  families: 'job_families',
  disciplines: 'job_disciplines',
  roles: 'roles',
  levels: 'job_levels',
  positions: 'positions',
};
const extra: Record<JobKind, Record<string, string>> = {
  families: {},
  disciplines: { jobFamilyId: 'job_family_id' },
  roles: { jobFamilyId: 'job_family_id', disciplineId: 'discipline_id' },
  levels: { rank: 'rank' },
  positions: {
    organizationalUnitId: 'organizational_unit_id',
    roleId: 'role_id',
    jobLevelId: 'job_level_id',
    reportsToPositionId: 'reports_to_position_id',
  },
};
const references: Record<string, string> = {
  jobFamilyId: 'job_families',
  disciplineId: 'job_disciplines',
  organizationalUnitId: 'organizational_units',
  roleId: 'roles',
  jobLevelId: 'job_levels',
  reportsToPositionId: 'positions',
};
const dependencies: Record<JobKind, [string, string][]> = {
  families: [
    ['job_disciplines', 'job_family_id'],
    ['roles', 'job_family_id'],
  ],
  disciplines: [['roles', 'discipline_id']],
  roles: [['positions', 'role_id']],
  levels: [['positions', 'job_level_id']],
  positions: [['positions', 'reports_to_position_id']],
};
const querySchema = z
  .object({
    search: z.string().trim().max(160).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    sort: z.enum(['name', 'code', 'updated']).default('name'),
  })
  .strict();

/** SQL identifiers come only from these static maps, never from request values. */
export class JobArchitectureService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly security: OrganizationStructureService,
  ) {}
  private kind(value: string): JobKind {
    return z.enum(jobKinds).parse(value);
  }
  private columns(kind: JobKind): string {
    return [
      'id',
      'organization_id AS organizationId',
      'name',
      'code',
      'description',
      'status',
      'version',
      'created_at AS createdAt',
      'updated_at AS updatedAt',
      ...Object.entries(extra[kind]).map(([key, column]) => `${column} AS ${key}`),
    ].join(',');
  }
  private get(actor: Actor, kind: JobKind, id: string): JobRecord {
    const row = this.db
      .prepare(`SELECT ${this.columns(kind)} FROM ${tables[kind]} WHERE organization_id=? AND id=?`)
      .get(actor.organizationId, id);
    if (!row) throw new OrganizationDomainError(404, 'JOB_RECORD_NOT_FOUND');
    return this.describeReferences(actor, kind, row as unknown as JobRecord);
  }
  private describeReferences(actor: Actor, kind: JobKind, record: JobRecord): JobRecord {
    const names: Record<string, string> = {};
    for (const key of Object.keys(extra[kind])) {
      const value = record[key as keyof JobRecord];
      if (references[key] && typeof value === 'string') {
        const row = this.db
          .prepare(`SELECT name FROM ${references[key]} WHERE organization_id=? AND id=?`)
          .get(actor.organizationId, value);
        if (row) names[key] = String(row['name']);
      }
    }
    return { ...record, referenceNames: names };
  }
  list(actor: Actor, resource: string, query: unknown): Page<JobRecord> {
    this.security.authorize(actor);
    const kind = this.kind(resource),
      input = querySchema.parse(query);
    const where = [
      'organization_id=?',
      '(instr(lower(name),lower(?))>0 OR instr(lower(code),lower(?))>0)',
    ];
    const values: SQLInputValue[] = [actor.organizationId, input.search, input.search];
    if (input.status !== 'all') {
      where.push('status=?');
      values.push(input.status);
    }
    const clause = where.join(' AND '),
      order = { name: 'name COLLATE NOCASE', code: 'code', updated: 'updated_at DESC' }[input.sort];
    const total = Number(
      this.db.prepare(`SELECT count(*) AS n FROM ${tables[kind]} WHERE ${clause}`).get(...values)![
        'n'
      ],
    );
    const items = this.db
      .prepare(
        `SELECT ${this.columns(kind)} FROM ${tables[kind]} WHERE ${clause} ORDER BY ${order},id LIMIT ? OFFSET ?`,
      )
      .all(...values, input.pageSize, (input.page - 1) * input.pageSize) as unknown as JobRecord[];
    return {
      items: items.map((record) => this.describeReferences(actor, kind, record)),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }
  private transaction<T>(actor: Actor, work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.security.authorize(actor);
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof OrganizationDomainError) throw error;
      if (
        error instanceof Error &&
        /UNIQUE constraint failed|JOB_FAMILY_MISMATCH|HIERARCHY_CYCLE/.test(error.message)
      )
        throw new OrganizationDomainError(409, 'JOB_DEPENDENCY_CONFLICT');
      throw error;
    }
  }
  private audit(
    actor: Actor,
    kind: JobKind,
    id: string,
    before: JobRecord | null,
    after: JobRecord,
  ): void {
    this.db
      .prepare('INSERT INTO organization_change_events VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        actor.organizationId,
        actor.id,
        after.status === 'archived' ? 'JOB_ARCHIVED' : before ? 'JOB_UPDATED' : 'JOB_CREATED',
        tables[kind],
        id,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        randomUUID(),
        new Date().toISOString(),
      );
  }
  save(actor: Actor, resource: string, raw: unknown, id?: string): JobRecord {
    const kind = this.kind(resource);
    const input = (
      id ? schemas[kind].extend({ version: z.number().int().positive() }) : schemas[kind]
    ).parse(raw) as Record<string, SQLInputValue>;
    if (id) uuid.parse(id);
    return this.transaction(actor, () => {
      const before = id ? this.get(actor, kind, id) : null;
      if (before && (before.version !== input['version'] || before.status !== 'active'))
        throw new OrganizationDomainError(409, 'JOB_VERSION_CONFLICT');
      for (const key of Object.keys(extra[kind])) {
        if (references[key] && input[key] !== null) {
          if (
            !this.db
              .prepare(
                `SELECT 1 FROM ${references[key]} WHERE organization_id=? AND id=? AND status='active'`,
              )
              .get(actor.organizationId, input[key])
          )
            throw new OrganizationDomainError(404, 'JOB_DEPENDENCY_NOT_FOUND');
          if (key === 'reportsToPositionId' && input[key] === id)
            throw new OrganizationDomainError(409, 'JOB_DEPENDENCY_CONFLICT');
        }
      }
      const key = id ?? randomUUID(),
        timestamp = new Date().toISOString();
      const mapping = { name: 'name', code: 'code', description: 'description', ...extra[kind] };
      const columns = Object.values(mapping),
        values = Object.keys(mapping).map((field) => input[field]);
      if (before)
        this.db
          .prepare(
            `UPDATE ${tables[kind]} SET ${columns.map((column) => `${column}=?`).join(',')},version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
          )
          .run(...values, timestamp, actor.id, actor.organizationId, key);
      else
        this.db
          .prepare(
            `INSERT INTO ${tables[kind]} (id,organization_id,${columns.join(',')},created_at,updated_at,created_by,updated_by) VALUES (${Array(
              columns.length + 6,
            )
              .fill('?')
              .join(',')})`,
          )
          .run(key, actor.organizationId, ...values, timestamp, timestamp, actor.id, actor.id);
      const result = this.get(actor, kind, key);
      this.audit(actor, kind, key, before, result);
      return result;
    });
  }
  archive(actor: Actor, resource: string, id: string, version: number): void {
    const kind = this.kind(resource);
    uuid.parse(id);
    z.number().int().positive().parse(version);
    this.transaction(actor, () => {
      const before = this.get(actor, kind, id);
      if (before.version !== version || before.status !== 'active')
        throw new OrganizationDomainError(409, 'JOB_VERSION_CONFLICT');
      for (const [table, column] of dependencies[kind]) {
        if (
          this.db
            .prepare(
              `SELECT 1 FROM ${table} WHERE organization_id=? AND ${column}=? AND status='active' LIMIT 1`,
            )
            .get(actor.organizationId, id)
        )
          throw new OrganizationDomainError(409, 'JOB_DEPENDENCY_CONFLICT');
      }
      this.db
        .prepare(
          `UPDATE ${tables[kind]} SET status='archived',version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
        )
        .run(new Date().toISOString(), actor.id, actor.organizationId, id);
      this.audit(actor, kind, id, before, this.get(actor, kind, id));
    });
  }
}
