import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import {
  unitTypes,
  type OrganizationUnit,
  type Page,
  type UnitMembership,
} from '../../../../packages/contracts/src/organization.js';

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
const unitColumns = `(SELECT p.name FROM organizational_units p WHERE p.id=organizational_units.parent_id AND p.organization_id=organizational_units.organization_id) AS parentName,
 id, organization_id AS organizationId, parent_id AS parentId, name, code,
 unit_type AS unitType, description, status, version, created_at AS createdAt, updated_at AS updatedAt`;

export class OrganizationDomainError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OrganizationStructureService {
  constructor(private readonly db: DatabaseSync) {}

  authorize(actor: Actor): void {
    if (
      actor.role !== 'ADMIN' ||
      !this.db
        .prepare(
          `SELECT 1 FROM employees e
      JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.user_id=e.user_id
      JOIN identities i ON i.employee_id=e.id AND i.user_id=e.user_id
      JOIN users u ON u.id=e.user_id AND u.status='active'
      JOIN organizations o ON o.id=e.organization_id AND o.status='active'
      WHERE e.id=? AND e.organization_id=? AND m.security_role='ADMIN' AND m.membership_status='active' AND e.employment_status='active' AND i.enabled=1`,
        )
        .get(actor.id, actor.organizationId)
    ) {
      throw new OrganizationDomainError(403, 'ORGANIZATION_ADMIN_REQUIRED');
    }
  }

  private unit(organizationId: string, unitId: string): OrganizationUnit {
    const row = this.db
      .prepare(`SELECT ${unitColumns} FROM organizational_units WHERE organization_id=? AND id=?`)
      .get(organizationId, unitId);
    if (!row) throw new OrganizationDomainError(404, 'UNIT_NOT_FOUND');
    return row as unknown as OrganizationUnit;
  }

  list(actor: Actor, query: unknown): Page<OrganizationUnit> {
    this.authorize(actor);
    const input = listInput.parse(query);
    const where = ['organization_id=?'];
    const values: SQLInputValue[] = [actor.organizationId];
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
      where.push('(instr(lower(name),lower(?))>0 OR instr(lower(code),lower(?))>0)');
      values.push(input.search, input.search);
    }
    const clause = where.join(' AND ');
    const total = Number(
      this.db
        .prepare(`SELECT count(*) AS n FROM organizational_units WHERE ${clause}`)
        .get(...values)!['n'],
    );
    const order = { name: 'name COLLATE NOCASE', code: 'code', updated: 'updated_at DESC' }[
      input.sort
    ];
    const items = this.db
      .prepare(
        `SELECT ${unitColumns} FROM organizational_units WHERE ${clause} ORDER BY ${order},id LIMIT ? OFFSET ?`,
      )
      .all(
        ...values,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as unknown as OrganizationUnit[];
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  ancestors(actor: Actor, unitId: string): OrganizationUnit[] {
    this.authorize(actor);
    const path: OrganizationUnit[] = [];
    let current: OrganizationUnit | null = this.unit(actor.organizationId, id.parse(unitId));
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.unit(actor.organizationId, current.parentId) : null;
    }
    return path;
  }

  private transaction<T>(actor: Actor, work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.authorize(actor);
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof OrganizationDomainError) throw error;
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
        throw new OrganizationDomainError(409, 'CODE_OR_MEMBERSHIP_CONFLICT');
      if (
        error instanceof Error &&
        /HIERARCHY_CYCLE|PARENT_INACTIVE|UNIT_HAS_CHILDREN|UNIT_HAS_MEMBERS/.test(error.message)
      )
        throw new OrganizationDomainError(409, 'HIERARCHY_CONFLICT');
      throw error;
    }
  }

  private audit(
    actor: Actor,
    action: string,
    resourceId: string,
    before: unknown,
    after: unknown,
  ): void {
    this.db
      .prepare('INSERT INTO organization_change_events VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
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

  save(actor: Actor, raw: unknown, unitId?: string): OrganizationUnit {
    const input = (
      unitId ? unitInput.extend({ version: z.number().int().positive() }) : unitInput
    ).parse(raw);
    if (unitId) id.parse(unitId);
    return this.transaction(actor, () => {
      const previous = unitId ? this.unit(actor.organizationId, unitId) : null;
      if (
        previous &&
        (previous.status !== 'active' ||
          previous.version !== ('version' in input ? input.version : 0))
      )
        throw new OrganizationDomainError(409, 'UNIT_VERSION_CONFLICT');
      if (input.parentId && this.unit(actor.organizationId, input.parentId).status !== 'active')
        throw new OrganizationDomainError(409, 'PARENT_INACTIVE');
      if (input.parentId === unitId) throw new OrganizationDomainError(409, 'HIERARCHY_CYCLE');
      const key = unitId ?? randomUUID();
      const timestamp = new Date().toISOString();
      if (previous) {
        this.db
          .prepare(
            `UPDATE organizational_units SET name=?,code=?,unit_type=?,parent_id=?,description=?,version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
          )
          .run(
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
        this.db
          .prepare(
            `INSERT INTO organizational_units (id,organization_id,name,code,unit_type,parent_id,description,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
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
      const result = this.unit(actor.organizationId, key);
      this.audit(
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

  archive(actor: Actor, unitId: string, version: number): void {
    id.parse(unitId);
    z.number().int().positive().parse(version);
    this.transaction(actor, () => {
      const previous = this.unit(actor.organizationId, unitId);
      if (previous.version !== version || previous.status !== 'active')
        throw new OrganizationDomainError(409, 'UNIT_VERSION_CONFLICT');
      this.db
        .prepare(
          `UPDATE organizational_units SET status='archived',version=version+1,updated_at=?,updated_by=? WHERE organization_id=? AND id=?`,
        )
        .run(new Date().toISOString(), actor.id, actor.organizationId, unitId);
      this.audit(
        actor,
        'ORG_UNIT_ARCHIVED',
        unitId,
        previous,
        this.unit(actor.organizationId, unitId),
      );
    });
  }

  members(actor: Actor, unitId: string, query: unknown): Page<UnitMembership> {
    this.authorize(actor);
    this.unit(actor.organizationId, id.parse(unitId));
    const { page, pageSize } = listInput.pick({ page: true, pageSize: true }).parse(query);
    const total = Number(
      this.db
        .prepare(
          'SELECT count(*) AS n FROM organizational_unit_memberships WHERE organization_id=? AND organizational_unit_id=?',
        )
        .get(actor.organizationId, unitId)!['n'],
    );
    const rows = this.db
      .prepare(
        `SELECT m.id,m.employee_id AS employeeId,e.display_name AS displayName,m.membership_type AS membershipType,m.is_primary AS isPrimary
      FROM organizational_unit_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.organizational_unit_id=? ORDER BY e.display_name,m.id LIMIT ? OFFSET ?`,
      )
      .all(
        actor.organizationId,
        unitId,
        pageSize,
        (page - 1) * pageSize,
      ) as unknown as UnitMembership[];
    return {
      items: rows.map((row) => ({ ...row, isPrimary: Boolean(row.isPrimary) })),
      total,
      page,
      pageSize,
    };
  }

  employeeOptions(actor: Actor, query: unknown): Page<{ id: string; name: string }> {
    this.authorize(actor);
    const { search, page, pageSize } = listInput
      .pick({ search: true, page: true, pageSize: true })
      .parse(query);
    const where =
      'organization_id=? AND (instr(lower(display_name),lower(?))>0 OR instr(lower(email),lower(?))>0)';
    const total = Number(
      this.db
        .prepare(`SELECT count(*) AS n FROM employees WHERE ${where}`)
        .get(actor.organizationId, search, search)!['n'],
    );
    const items = this.db
      .prepare(
        `SELECT id,display_name AS name FROM employees WHERE ${where} ORDER BY display_name,id LIMIT ? OFFSET ?`,
      )
      .all(actor.organizationId, search, search, pageSize, (page - 1) * pageSize) as unknown as {
      id: string;
      name: string;
    }[];
    return { items, total, page, pageSize };
  }

  addMember(actor: Actor, unitId: string, raw: unknown): void {
    id.parse(unitId);
    const input = z
      .object({
        employeeId: id,
        membershipType: z.enum(['member', 'lead', 'manager', 'owner', 'contributor']),
        isPrimary: z.boolean(),
      })
      .strict()
      .parse(raw);
    this.transaction(actor, () => {
      if (this.unit(actor.organizationId, unitId).status !== 'active')
        throw new OrganizationDomainError(409, 'UNIT_INACTIVE');
      if (
        !this.db
          .prepare(`SELECT 1 FROM employees WHERE organization_id=? AND id=?`)
          .get(actor.organizationId, input.employeeId)
      )
        throw new OrganizationDomainError(404, 'EMPLOYEE_NOT_FOUND');
      const membershipId = randomUUID();
      this.db
        .prepare('INSERT INTO organizational_unit_memberships VALUES (?,?,?,?,?,?,?,?)')
        .run(
          membershipId,
          actor.organizationId,
          unitId,
          input.employeeId,
          input.membershipType,
          Number(input.isPrimary),
          new Date().toISOString(),
          actor.id,
        );
      this.audit(actor, 'UNIT_MEMBER_ADDED', unitId, null, { id: membershipId, ...input });
    });
  }

  removeMember(actor: Actor, unitId: string, membershipId: string): void {
    id.parse(unitId);
    id.parse(membershipId);
    this.transaction(actor, () => {
      const previous = this.db
        .prepare(
          'SELECT id,employee_id,membership_type,is_primary FROM organizational_unit_memberships WHERE organization_id=? AND organizational_unit_id=? AND id=?',
        )
        .get(actor.organizationId, unitId, membershipId);
      if (!previous) throw new OrganizationDomainError(404, 'MEMBERSHIP_NOT_FOUND');
      this.db
        .prepare('DELETE FROM organizational_unit_memberships WHERE organization_id=? AND id=?')
        .run(actor.organizationId, membershipId);
      this.audit(actor, 'UNIT_MEMBER_REMOVED', unitId, previous, null);
    });
  }
}
