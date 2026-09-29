import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import {
  unitTypes,
  type OrganizationUnit,
  type Page,
  type UnitMembership,
} from '../../../../packages/contracts/src/organization.js';
import { constraintKind, type PgStore, type SqlParam } from '../db/pg-store.js';

const id = z.string().uuid();
export const unitInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/),
    unitType: z.enum(unitTypes),
    parentId: id.nullable(),
    description: z.string().trim().max(2000).default(''),
  })
  .strict();
export const listInput = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(160).default(''),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    unitType: z.enum(unitTypes).optional(),
    parentId: z.union([id, z.literal('root')]).optional(),
    sort: z.enum(['name', 'code', 'updated']).default('name'),
  })
  .strict();
const unitColumns = `(SELECT p.name FROM organizational_units p WHERE p.id=organizational_units.parent_id AND p.organization_id=organizational_units.organization_id) AS "parentName",
 (SELECT p.name FROM positions p WHERE p.id=organizational_units.head_position_id) AS "headPositionName",
 (SELECT e.display_name FROM positions p JOIN employee_position_assignments a ON a.position_id=p.id AND a.organization_id=p.organization_id AND a.ended_at IS NULL JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id WHERE p.id=organizational_units.head_position_id) AS "headEmployeeName",
 id, organization_id AS "organizationId", parent_id AS "parentId", name, code,
 unit_type AS "unitType", description, head_position_id AS "headPositionId", status, version, created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Case-insensitive substring match on `column` (the search text is a parameter). */
export const contains = (column: string) => `strpos(lower(${column}),lower(?::text))>0`;

export class OrganizationDomainError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OrganizationStructureService {
  constructor(private readonly db: PgStore) {}

  /** The actor must be an active admin of an active organization; runs in its tenant scope. */
  authorize(actor: Actor): Promise<void> {
    return this.db.tenant(actor.organizationId, async () => {
      if (
        actor.role !== 'ADMIN' ||
        !(await this.db.get(
          `SELECT 1 FROM employees e
      JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.user_id=e.user_id
      JOIN users u ON u.id=e.user_id AND u.status='active'
      JOIN organizations o ON o.id=e.organization_id AND o.status='active'
      WHERE e.id=? AND e.organization_id=? AND m.security_role='ADMIN' AND m.membership_status='active' AND e.employment_status='active'`,
          actor.id,
          actor.organizationId,
        ))
      ) {
        throw new OrganizationDomainError(403, 'ORGANIZATION_ADMIN_REQUIRED');
      }
    });
  }

  /** Runs `work` as the authorized admin, in the admin's tenant scope. */
  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.authorize(actor);
      return work();
    });
  }

  private async unit(organizationId: string, unitId: string): Promise<OrganizationUnit> {
    const row = await this.db.get(
      `SELECT ${unitColumns} FROM organizational_units WHERE organization_id=? AND id=?`,
      organizationId,
      unitId,
    );
    if (!row) throw new OrganizationDomainError(404, 'UNIT_NOT_FOUND');
    return row as unknown as OrganizationUnit;
  }

  list(actor: Actor, query: unknown): Promise<Page<OrganizationUnit>> {
    return this.asAdmin(actor, async () => {
      const input = listInput.parse(query);
      const where = ['organization_id=?'];
      const values: SqlParam[] = [actor.organizationId];
      if (input.status !== 'all') {
        where.push('status=?');
        values.push(input.status);
      }
      if (input.unitType) {
        where.push('unit_type=?');
        values.push(input.unitType);
      }
      if (input.parentId === 'root') where.push('parent_id IS NULL');
      else if (input.parentId) {
        where.push('parent_id=?');
        values.push(input.parentId);
      }
      if (input.search) {
        where.push(`(${contains('name')} OR ${contains('code')})`);
        values.push(input.search, input.search);
      }
      const clause = where.join(' AND ');
      const total = Number(
        (await this.db.get(
          `SELECT count(*) AS n FROM organizational_units WHERE ${clause}`,
          ...values,
        ))!['n'],
      );
      const order = { name: 'lower(name)', code: 'code', updated: 'updated_at DESC' }[input.sort];
      const items = (await this.db.all(
        `SELECT ${unitColumns} FROM organizational_units WHERE ${clause} ORDER BY ${order},id LIMIT ? OFFSET ?`,
        ...values,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      )) as unknown as OrganizationUnit[];
      return { items, total, page: input.page, pageSize: input.pageSize };
    });
  }

  ancestors(actor: Actor, unitId: string): Promise<OrganizationUnit[]> {
    return this.asAdmin(actor, async () => {
      const path: OrganizationUnit[] = [];
      let current: OrganizationUnit | null = await this.unit(
        actor.organizationId,
        id.parse(unitId),
      );
      while (current) {
        path.unshift(current);
        current = current.parentId ? await this.unit(actor.organizationId, current.parentId) : null;
      }
      return path;
    });
  }

  private async transaction<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    try {
      return await this.asAdmin(actor, work);
    } catch (error) {
      if (error instanceof OrganizationDomainError) throw error;
      if (constraintKind(error) === 'unique')
        throw new OrganizationDomainError(409, 'CODE_OR_MEMBERSHIP_CONFLICT');
      if (
        error instanceof Error &&
        /HIERARCHY_CYCLE|PARENT_INACTIVE|UNIT_HAS_CHILDREN|UNIT_HAS_MEMBERS/.test(error.message)
      )
        throw new OrganizationDomainError(409, 'HIERARCHY_CONFLICT');
      if (
        error instanceof Error &&
        /INVALID_HEAD_POSITION|HEAD_POSITION_IN_USE/.test(error.message)
      )
        throw new OrganizationDomainError(409, 'HEAD_POSITION_CONFLICT');
      throw error;
    }
  }

  private async audit(
    actor: Actor,
    action: string,
    resourceId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO organization_change_events (id,organization_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(),
      actor.organizationId,
      actor.id,
      action,
      'organizational_unit',
      resourceId,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      randomUUID(),
      new Date().toISOString(),
    );
  }

  async save(actor: Actor, raw: unknown, unitId?: string): Promise<OrganizationUnit> {
    const input = (
      unitId ? unitInput.extend({ version: z.number().int().positive() }) : unitInput
    ).parse(raw);
    if (unitId) id.parse(unitId);
    return this.transaction(actor, async () => {
      const previous = unitId ? await this.unit(actor.organizationId, unitId) : null;
      if (
        previous &&
        (previous.status !== 'active' ||
          previous.version !== ('version' in input ? input.version : 0))
      )
        throw new OrganizationDomainError(409, 'UNIT_VERSION_CONFLICT');
      if (
        input.parentId &&
        (await this.unit(actor.organizationId, input.parentId)).status !== 'active'
      )
        throw new OrganizationDomainError(409, 'PARENT_INACTIVE');
      if (input.parentId === unitId) throw new OrganizationDomainError(409, 'HIERARCHY_CYCLE');
      const key = unitId ?? randomUUID();
      const timestamp = new Date().toISOString();
      if (previous) {
        await this.db.run(
          `UPDATE organizational_units SET name=?,code=?,unit_type=?,parent_id=?,description=?,version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
          input.name,
          input.code,
          input.unitType,
          input.parentId,
          input.description,
          timestamp,
          actor.id,
          actor.organizationId,
          key,
        );
      } else {
        await this.db.run(
          `INSERT INTO organizational_units (id,organization_id,name,code,unit_type,parent_id,description,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          key,
          actor.organizationId,
          input.name,
          input.code,
          input.unitType,
          input.parentId,
          input.description,
          timestamp,
          timestamp,
          actor.id,
          actor.id,
        );
      }
      const result = await this.unit(actor.organizationId, key);
      await this.audit(
        actor,
        previous
          ? previous.parentId !== input.parentId
            ? 'ORG_UNIT_MOVED'
            : 'ORG_UNIT_UPDATED'
          : 'ORG_UNIT_CREATED',
        key,
        previous,
        result,
      );
      return result;
    });
  }

  async archive(actor: Actor, unitId: string, version: number): Promise<void> {
    id.parse(unitId);
    z.number().int().positive().parse(version);
    await this.transaction(actor, async () => {
      const previous = await this.unit(actor.organizationId, unitId);
      if (previous.version !== version || previous.status !== 'active')
        throw new OrganizationDomainError(409, 'UNIT_VERSION_CONFLICT');
      await this.db.run(
        `UPDATE organizational_units SET status='archived',version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
        new Date().toISOString(),
        actor.id,
        actor.organizationId,
        unitId,
      );
      await this.audit(
        actor,
        'ORG_UNIT_ARCHIVED',
        unitId,
        previous,
        await this.unit(actor.organizationId, unitId),
      );
    });
  }

  headPositionOptions(
    actor: Actor,
    unitId: string,
    query: unknown,
  ): Promise<Page<{ id: string; name: string }>> {
    return this.asAdmin(actor, async () => {
      await this.unit(actor.organizationId, id.parse(unitId));
      const { search, page, pageSize } = listInput
        .pick({ search: true, page: true, pageSize: true })
        .parse(query);
      const values = [actor.organizationId, unitId, search, search];
      const where = `organization_id=? AND organizational_unit_id=? AND status='active' AND (${contains('name')} OR ${contains('code')})`;
      const total = Number(
        (await this.db.get(`SELECT count(*) AS n FROM positions WHERE ${where}`, ...values))!['n'],
      );
      const items = (await this.db.all(
        `SELECT id,name FROM positions WHERE ${where} ORDER BY name,id LIMIT ? OFFSET ?`,
        ...values,
        pageSize,
        (page - 1) * pageSize,
      )) as unknown as { id: string; name: string }[];
      return { items, total, page, pageSize };
    });
  }

  async setHeadPosition(actor: Actor, unitId: string, raw: unknown): Promise<OrganizationUnit> {
    id.parse(unitId);
    const { positionId, version } = z
      .object({ positionId: id.nullable(), version: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.transaction(actor, async () => {
      const previous = await this.unit(actor.organizationId, unitId);
      if (previous.status !== 'active' || previous.version !== version)
        throw new OrganizationDomainError(409, 'UNIT_VERSION_CONFLICT');
      if (
        positionId &&
        !(await this.db.get(
          "SELECT 1 FROM positions WHERE id=? AND organization_id=? AND organizational_unit_id=? AND status='active'",
          positionId,
          actor.organizationId,
          unitId,
        ))
      )
        throw new OrganizationDomainError(409, 'HEAD_POSITION_CONFLICT');
      await this.db.run(
        'UPDATE organizational_units SET head_position_id=?,version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?',
        positionId,
        new Date().toISOString(),
        actor.id,
        actor.organizationId,
        unitId,
      );
      const result = await this.unit(actor.organizationId, unitId);
      await this.audit(actor, 'ORG_UNIT_HEAD_CHANGED', unitId, previous, result);
      return result;
    });
  }

  members(actor: Actor, unitId: string, query: unknown): Promise<Page<UnitMembership>> {
    return this.asAdmin(actor, async () => {
      await this.unit(actor.organizationId, id.parse(unitId));
      const { page, pageSize, status } = z
        .object({
          page: z.coerce.number().int().min(1).max(100000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
          status: z.enum(['active', 'ended', 'all']).default('active'),
        })
        .strict()
        .parse(query);
      const period =
        status === 'all'
          ? ''
          : status === 'active'
            ? ' AND ended_at IS NULL'
            : ' AND ended_at IS NOT NULL';
      const total = Number(
        (await this.db.get(
          `SELECT count(*) AS n FROM organizational_unit_memberships WHERE organization_id=? AND organizational_unit_id=?${period}`,
          actor.organizationId,
          unitId,
        ))!['n'],
      );
      const rows = (await this.db.all(
        `SELECT m.id,m.employee_id AS "employeeId",e.display_name AS "displayName",m.membership_type AS "membershipType",m.is_primary AS "isPrimary",m.started_at AS "startedAt",m.ended_at AS "endedAt",m.version
      FROM organizational_unit_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.organizational_unit_id=?${period.replaceAll('ended_at', 'm.ended_at')} ORDER BY e.display_name,m.started_at DESC,m.id LIMIT ? OFFSET ?`,
        actor.organizationId,
        unitId,
        pageSize,
        (page - 1) * pageSize,
      )) as unknown as UnitMembership[];
      return {
        items: rows.map((row) => ({ ...row, isPrimary: Boolean(row.isPrimary) })),
        total,
        page,
        pageSize,
      };
    });
  }

  employeeOptions(actor: Actor, query: unknown): Promise<Page<{ id: string; name: string }>> {
    return this.asAdmin(actor, async () => {
      const { search, page, pageSize } = listInput
        .pick({ search: true, page: true, pageSize: true })
        .parse(query);
      const where = `organization_id=? AND (${contains('display_name')} OR ${contains('email')})`;
      const total = Number(
        (await this.db.get(
          `SELECT count(*) AS n FROM employees WHERE ${where}`,
          actor.organizationId,
          search,
          search,
        ))!['n'],
      );
      const items = (await this.db.all(
        `SELECT id,display_name AS name FROM employees WHERE ${where} ORDER BY display_name,id LIMIT ? OFFSET ?`,
        actor.organizationId,
        search,
        search,
        pageSize,
        (page - 1) * pageSize,
      )) as unknown as { id: string; name: string }[];
      return { items, total, page, pageSize };
    });
  }

  async addMember(actor: Actor, unitId: string, raw: unknown): Promise<void> {
    id.parse(unitId);
    const input = z
      .object({
        employeeId: id,
        membershipType: z.enum(['member', 'lead', 'manager', 'owner', 'contributor']),
        isPrimary: z.boolean(),
        startedAt: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(raw);
    await this.transaction(actor, async () => {
      if ((await this.unit(actor.organizationId, unitId)).status !== 'active')
        throw new OrganizationDomainError(409, 'UNIT_INACTIVE');
      if (
        !(await this.db.get(
          `SELECT 1 FROM employees WHERE organization_id=? AND id=?`,
          actor.organizationId,
          input.employeeId,
        ))
      )
        throw new OrganizationDomainError(404, 'EMPLOYEE_NOT_FOUND');
      const membershipId = randomUUID();
      const now = new Date().toISOString();
      const startedAt = input.startedAt ? new Date(input.startedAt).toISOString() : now;
      if (startedAt > now) throw new OrganizationDomainError(400, 'MEMBERSHIP_START_IN_FUTURE');
      if (
        await this.db.get(
          'SELECT 1 FROM organizational_unit_memberships WHERE organization_id=? AND organizational_unit_id=? AND employee_id=? AND ended_at>? LIMIT 1',
          actor.organizationId,
          unitId,
          input.employeeId,
          startedAt,
        )
      )
        throw new OrganizationDomainError(409, 'MEMBERSHIP_DATE_CONFLICT');
      await this.db.run(
        'INSERT INTO organizational_unit_memberships (id,organization_id,organizational_unit_id,employee_id,membership_type,is_primary,created_at,created_by,started_at) VALUES (?,?,?,?,?,?,?,?,?)',
        membershipId,
        actor.organizationId,
        unitId,
        input.employeeId,
        input.membershipType,
        Number(input.isPrimary),
        now,
        actor.id,
        startedAt,
      );
      await this.audit(actor, 'UNIT_MEMBER_ADDED', unitId, null, {
        id: membershipId,
        ...input,
        startedAt,
      });
    });
  }

  async removeMember(actor: Actor, unitId: string, membershipId: string): Promise<void> {
    id.parse(unitId);
    id.parse(membershipId);
    await this.transaction(actor, async () => {
      const previous = await this.db.get(
        'SELECT id,employee_id,membership_type,is_primary,started_at,ended_at,version FROM organizational_unit_memberships WHERE organization_id=? AND organizational_unit_id=? AND id=?',
        actor.organizationId,
        unitId,
        membershipId,
      );
      if (!previous) throw new OrganizationDomainError(404, 'MEMBERSHIP_NOT_FOUND');
      if (previous['ended_at']) throw new OrganizationDomainError(409, 'MEMBERSHIP_ALREADY_ENDED');
      const now = new Date().toISOString();
      if (now < String(previous['started_at']))
        throw new OrganizationDomainError(409, 'MEMBERSHIP_DATE_CONFLICT');
      await this.db.run(
        'UPDATE organizational_unit_memberships SET ended_at=?,version=version+1 WHERE organization_id=? AND id=?',
        now,
        actor.organizationId,
        membershipId,
      );
      await this.audit(actor, 'UNIT_MEMBER_ENDED', unitId, previous, {
        ...previous,
        ended_at: now,
        version: Number(previous['version']) + 1,
      });
    });
  }
}
