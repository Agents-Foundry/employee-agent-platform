import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import { jobKinds, type JobKind, type JobRecord } from '../../../../packages/contracts/src/jobs.js';
import type { Page } from '../../../../packages/contracts/src/organization.js';
import { constraintKind, type PgStore, type SqlParam } from '../db/pg-store.js';
import {
  OrganizationDomainError,
  contains,
  type OrganizationStructureService,
} from './structure-service.js';

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
    private readonly db: PgStore,
    private readonly security: OrganizationStructureService,
  ) {}
  private kind(value: string): JobKind {
    return z.enum(jobKinds).parse(value);
  }
  private columns(kind: JobKind): string {
    return [
      'id',
      'organization_id AS "organizationId"',
      'name',
      'code',
      'description',
      'status',
      'version',
      'created_at AS "createdAt"',
      'updated_at AS "updatedAt"',
      ...Object.entries(extra[kind]).map(([key, column]) => `${column} AS "${key}"`),
    ].join(',');
  }
  private async get(actor: Actor, kind: JobKind, id: string): Promise<JobRecord> {
    const row = await this.db.get(
      `SELECT ${this.columns(kind)} FROM ${tables[kind]} WHERE organization_id=? AND id=?`,
      actor.organizationId,
      id,
    );
    if (!row) throw new OrganizationDomainError(404, 'JOB_RECORD_NOT_FOUND');
    return this.describeReferences(actor, kind, row as unknown as JobRecord);
  }
  private async describeReferences(
    actor: Actor,
    kind: JobKind,
    record: JobRecord,
  ): Promise<JobRecord> {
    const names: Record<string, string> = {};
    for (const key of Object.keys(extra[kind])) {
      const value = record[key as keyof JobRecord];
      if (references[key] && typeof value === 'string') {
        const row = await this.db.get(
          `SELECT name FROM ${references[key]} WHERE organization_id=? AND id=?`,
          actor.organizationId,
          value,
        );
        if (row) names[key] = String(row['name']);
      }
    }
    return { ...record, referenceNames: names };
  }
  list(actor: Actor, resource: string, query: unknown): Promise<Page<JobRecord>> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.security.authorize(actor);
      const kind = this.kind(resource),
        input = querySchema.parse(query);
      const where = ['organization_id=?', `(${contains('name')} OR ${contains('code')})`];
      const values: SqlParam[] = [actor.organizationId, input.search, input.search];
      if (input.status !== 'all') {
        where.push('status=?');
        values.push(input.status);
      }
      const clause = where.join(' AND '),
        order = { name: 'lower(name)', code: 'code', updated: 'updated_at DESC' }[input.sort];
      const total = Number(
        (await this.db.get(
          `SELECT count(*) AS n FROM ${tables[kind]} WHERE ${clause}`,
          ...values,
        ))!['n'],
      );
      const items = (await this.db.all(
        `SELECT ${this.columns(kind)} FROM ${tables[kind]} WHERE ${clause} ORDER BY ${order},id LIMIT ? OFFSET ?`,
        ...values,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      )) as unknown as JobRecord[];
      const described: JobRecord[] = [];
      for (const record of items)
        described.push(await this.describeReferences(actor, kind, record));
      return { items: described, total, page: input.page, pageSize: input.pageSize };
    });
  }
  private async transaction<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    try {
      return await this.db.tenant(actor.organizationId, async () => {
        await this.security.authorize(actor);
        return work();
      });
    } catch (error) {
      if (error instanceof OrganizationDomainError) throw error;
      if (
        constraintKind(error) === 'unique' ||
        (error instanceof Error && /JOB_FAMILY_MISMATCH|HIERARCHY_CYCLE/.test(error.message))
      )
        throw new OrganizationDomainError(409, 'JOB_DEPENDENCY_CONFLICT');
      throw error;
    }
  }
  private async audit(
    actor: Actor,
    kind: JobKind,
    id: string,
    before: JobRecord | null,
    after: JobRecord,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO organization_change_events (id,organization_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
  async save(actor: Actor, resource: string, raw: unknown, id?: string): Promise<JobRecord> {
    const kind = this.kind(resource);
    const input = (
      id ? schemas[kind].extend({ version: z.number().int().positive() }) : schemas[kind]
    ).parse(raw) as Record<string, SqlParam>;
    if (id) uuid.parse(id);
    return this.transaction(actor, async () => {
      const before = id ? await this.get(actor, kind, id) : null;
      if (before && (before.version !== input['version'] || before.status !== 'active'))
        throw new OrganizationDomainError(409, 'JOB_VERSION_CONFLICT');
      for (const key of Object.keys(extra[kind])) {
        if (references[key] && input[key] !== null) {
          if (
            !(await this.db.get(
              `SELECT 1 FROM ${references[key]} WHERE organization_id=? AND id=? AND status='active'`,
              actor.organizationId,
              input[key]!,
            ))
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
        values = Object.keys(mapping).map((field) => input[field] ?? null);
      if (before)
        await this.db.run(
          `UPDATE ${tables[kind]} SET ${columns.map((column) => `${column}=?`).join(',')},version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
          ...values,
          timestamp,
          actor.id,
          actor.organizationId,
          key,
        );
      else
        await this.db.run(
          `INSERT INTO ${tables[kind]} (id,organization_id,${columns.join(',')},created_at,updated_at,created_by,updated_by) VALUES (${Array(
            columns.length + 6,
          )
            .fill('?')
            .join(',')})`,
          key,
          actor.organizationId,
          ...values,
          timestamp,
          timestamp,
          actor.id,
          actor.id,
        );
      const result = await this.get(actor, kind, key);
      await this.audit(actor, kind, key, before, result);
      return result;
    });
  }
  async archive(actor: Actor, resource: string, id: string, version: number): Promise<void> {
    const kind = this.kind(resource);
    uuid.parse(id);
    z.number().int().positive().parse(version);
    await this.transaction(actor, async () => {
      const before = await this.get(actor, kind, id);
      if (before.version !== version || before.status !== 'active')
        throw new OrganizationDomainError(409, 'JOB_VERSION_CONFLICT');
      for (const [table, column] of dependencies[kind]) {
        if (
          await this.db.get(
            `SELECT 1 FROM ${table} WHERE organization_id=? AND ${column}=? AND status='active' LIMIT 1`,
            actor.organizationId,
            id,
          )
        )
          throw new OrganizationDomainError(409, 'JOB_DEPENDENCY_CONFLICT');
      }
      await this.db.run(
        `UPDATE ${tables[kind]} SET status='archived',version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
        new Date().toISOString(),
        actor.id,
        actor.organizationId,
        id,
      );
      await this.audit(actor, kind, id, before, await this.get(actor, kind, id));
    });
  }
}
