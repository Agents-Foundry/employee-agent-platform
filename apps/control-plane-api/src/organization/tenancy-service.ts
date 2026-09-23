import { randomBytes, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import type {
  OrganizationProfile,
  TenantDomain,
  EmploymentRecord,
  OrganizationMembership,
} from '../../../../packages/contracts/src/tenancy.js';
import type { Page } from '../../../../packages/contracts/src/organization.js';
import { LOCAL_ISSUER } from '../onboarding-types.js';
import { OrganizationDomainError, OrganizationStructureService } from './structure-service.js';

const id = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);
const profileInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    legalName: text(200),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    website: z.union([z.literal(''), z.url().startsWith('https://')]),
    industry: text(160),
    country: z.union([z.literal(''), z.string().regex(/^[A-Z]{2}$/)]),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
    locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    version: z.number().int().positive(),
  })
  .strict();
const employeeInput = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    employeeNumber: text(60).nullable(),
    employmentType: z.enum(['employee', 'contractor', 'external']),
  })
  .strict();
const pageInput = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: text(160).default(''),
    status: z.enum(['active', 'inactive', 'all']).default('active'),
  })
  .strict();
const domainInput = z
  .object({
    domain: z.string().trim().max(253),
    domainType: z.enum(['custom_domain', 'platform_subdomain']),
  })
  .strict();
const profileColumns = `id,name,legal_name AS legalName,code,slug,website,industry,country,timezone,locale,status,version,updated_at AS updatedAt`;
const domainColumns = `id,organization_id AS organizationId,domain,domain_type AS domainType,is_primary AS isPrimary,verification_status AS verificationStatus,verification_token AS verificationToken,verified_at AS verifiedAt,version`;
const employeeColumns = `e.id,e.organization_id AS organizationId,e.user_id AS userId,e.display_name AS displayName,e.email,e.employee_number AS employeeNumber,e.employment_type AS employmentType,e.employment_status AS employmentStatus,e.version,
 a.position_id AS positionId,p.name AS positionTitle,u.name AS unitName,r.name AS roleName,l.name AS levelName`;
const employeeJoins = `LEFT JOIN employee_position_assignments a ON a.organization_id=e.organization_id AND a.employee_id=e.id AND a.ended_at IS NULL
 LEFT JOIN positions p ON p.id=a.position_id AND p.organization_id=e.organization_id
 LEFT JOIN organizational_units u ON u.id=p.organizational_unit_id AND u.organization_id=e.organization_id
 LEFT JOIN roles r ON r.id=p.role_id AND r.organization_id=e.organization_id
 LEFT JOIN job_levels l ON l.id=p.job_level_id AND l.organization_id=e.organization_id`;

function hostname(value: string): string {
  const normalized = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ''));
  if (
    !normalized ||
    normalized.length > 253 ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(normalized) ||
    normalized
      .split('.')
      .some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
    /\.(localhost|local|internal|test|example|invalid)$/.test(normalized)
  )
    throw new OrganizationDomainError(400, 'INVALID_DOMAIN');
  return normalized;
}

export class TenancyService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly security: OrganizationStructureService,
  ) {}
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
        /UNIQUE constraint failed|CHECK constraint failed/.test(error.message)
      )
        throw new OrganizationDomainError(409, 'TENANT_RECORD_CONFLICT');
      throw error;
    }
  }
  private audit(
    actor: Actor,
    action: string,
    type: string,
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
        type,
        resourceId,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        randomUUID(),
        new Date().toISOString(),
      );
  }
  private revokeSessions(employeeId: string): void {
    this.db
      .prepare(
        'DELETE FROM auth_sessions WHERE EXISTS (SELECT 1 FROM identities i WHERE i.issuer=auth_sessions.issuer AND i.subject=auth_sessions.subject AND i.employee_id=?)',
      )
      .run(employeeId);
  }
  profile(actor: Actor): OrganizationProfile {
    this.security.authorize(actor);
    return this.db
      .prepare(`SELECT ${profileColumns} FROM organizations WHERE id=?`)
      .get(actor.organizationId) as unknown as OrganizationProfile;
  }
  updateProfile(actor: Actor, raw: unknown): OrganizationProfile {
    const input = profileInput.parse(raw);
    return this.transaction(actor, () => {
      const before = this.profile(actor);
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'PROFILE_VERSION_CONFLICT');
      this.db
        .prepare(
          `UPDATE organizations SET name=?,legal_name=?,code=?,slug=?,website=?,industry=?,country=?,timezone=?,locale=?,version=version+1,updated_at=?,updated_by=? WHERE id=?`,
        )
        .run(
          input.name,
          input.legalName,
          input.code,
          input.slug,
          input.website,
          input.industry,
          input.country,
          input.timezone,
          input.locale,
          new Date().toISOString(),
          actor.id,
          actor.organizationId,
        );
      const after = this.profile(actor);
      this.audit(
        actor,
        'ORGANIZATION_PROFILE_UPDATED',
        'organization',
        actor.organizationId,
        before,
        after,
      );
      return after;
    });
  }
  listDomains(actor: Actor): TenantDomain[] {
    this.security.authorize(actor);
    return (
      this.db
        .prepare(
          `SELECT ${domainColumns} FROM organization_domains WHERE organization_id=? ORDER BY is_primary DESC,domain`,
        )
        .all(actor.organizationId) as unknown as TenantDomain[]
    ).map((row) => ({
      ...row,
      isPrimary: Boolean(row.isPrimary),
      verificationToken: row.verificationStatus === 'pending' ? row.verificationToken : null,
    }));
  }
  registerDomain(actor: Actor, raw: unknown): TenantDomain {
    const input = domainInput.parse(raw),
      domain = hostname(input.domain);
    return this.transaction(actor, () => {
      const domainId = randomUUID(),
        token = `af-verify=${randomBytes(24).toString('base64url')}`,
        time = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO organization_domains(id,organization_id,domain,domain_type,verification_token,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(domainId, actor.organizationId, domain, input.domainType, token, time, time, actor.id);
      const result = this.listDomains(actor).find((item) => item.id === domainId)!;
      this.audit(actor, 'DOMAIN_REGISTERED', 'organization_domain', domainId, null, {
        domain,
        domainType: input.domainType,
      });
      return result;
    });
  }
  async verifyDomain(
    actor: Actor,
    domainId: string,
    lookup: (name: string) => Promise<string[][]> = (name) =>
      new Resolver({ timeout: 3000, tries: 1 }).resolveTxt(name),
  ): Promise<TenantDomain> {
    id.parse(domainId);
    this.security.authorize(actor);
    const current = this.db
      .prepare(
        'SELECT domain,verification_token,verification_status,version FROM organization_domains WHERE organization_id=? AND id=?',
      )
      .get(actor.organizationId, domainId);
    if (!current) throw new OrganizationDomainError(404, 'DOMAIN_NOT_FOUND');
    if (current['verification_status'] !== 'pending')
      throw new OrganizationDomainError(409, 'DOMAIN_STATE_CONFLICT');
    let records: string[][];
    try {
      records = await lookup(`_agents-foundry-verification.${current['domain']}`);
    } catch {
      throw new OrganizationDomainError(409, 'DOMAIN_PROOF_NOT_FOUND');
    }
    if (!records.some((parts) => parts.join('') === current['verification_token']))
      throw new OrganizationDomainError(409, 'DOMAIN_PROOF_NOT_FOUND');
    return this.transaction(actor, () => {
      const fresh = this.db
        .prepare(
          'SELECT version,verification_token,verification_status FROM organization_domains WHERE organization_id=? AND id=?',
        )
        .get(actor.organizationId, domainId);
      if (
        !fresh ||
        fresh['version'] !== current['version'] ||
        fresh['verification_token'] !== current['verification_token'] ||
        fresh['verification_status'] !== 'pending'
      )
        throw new OrganizationDomainError(409, 'DOMAIN_STATE_CONFLICT');
      const time = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE organization_domains SET verification_status='verified',verification_token='',verified_at=?,updated_at=?,version=version+1 WHERE organization_id=? AND id=?",
        )
        .run(time, time, actor.organizationId, domainId);
      this.audit(
        actor,
        'DOMAIN_VERIFIED',
        'organization_domain',
        domainId,
        { domain: current['domain'] },
        { verifiedAt: time },
      );
      return this.listDomains(actor).find((item) => item.id === domainId)!;
    });
  }
  setPrimaryDomain(actor: Actor, domainId: string): TenantDomain {
    id.parse(domainId);
    return this.transaction(actor, () => {
      const current = this.db
        .prepare(
          'SELECT domain,verification_status FROM organization_domains WHERE organization_id=? AND id=?',
        )
        .get(actor.organizationId, domainId);
      if (!current) throw new OrganizationDomainError(404, 'DOMAIN_NOT_FOUND');
      if (current['verification_status'] !== 'verified')
        throw new OrganizationDomainError(409, 'DOMAIN_UNVERIFIED');
      this.db
        .prepare(
          'UPDATE organization_domains SET is_primary=0,version=version+1 WHERE organization_id=? AND is_primary=1',
        )
        .run(actor.organizationId);
      this.db
        .prepare(
          'UPDATE organization_domains SET is_primary=1,version=version+1,updated_at=? WHERE organization_id=? AND id=?',
        )
        .run(new Date().toISOString(), actor.organizationId, domainId);
      this.audit(actor, 'DOMAIN_PRIMARY_CHANGED', 'organization_domain', domainId, null, {
        domain: current['domain'],
      });
      return this.listDomains(actor).find((item) => item.id === domainId)!;
    });
  }
  resolveVerifiedDomain(host: string): string | null {
    let domain: string;
    try {
      domain = hostname(host);
    } catch {
      return null;
    }
    const row = this.db
      .prepare(
        "SELECT d.organization_id FROM organization_domains d JOIN organizations o ON o.id=d.organization_id AND o.status='active' WHERE d.domain=? COLLATE NOCASE AND d.verification_status='verified'",
      )
      .get(domain);
    return row ? String(row['organization_id']) : null;
  }
  listEmployees(actor: Actor, raw: unknown): Page<EmploymentRecord> {
    this.security.authorize(actor);
    const input = pageInput.parse(raw),
      where = [
        'e.organization_id=?',
        "(instr(lower(e.display_name),lower(?))>0 OR instr(lower(e.email),lower(?))>0 OR instr(lower(coalesce(e.employee_number,'')),lower(?))>0)",
      ];
    const values: SQLInputValue[] = [
      actor.organizationId,
      input.search,
      input.search,
      input.search,
    ];
    if (input.status !== 'all') {
      where.push('e.employment_status=?');
      values.push(input.status);
    }
    const clause = where.join(' AND '),
      total = Number(
        this.db.prepare(`SELECT count(*) AS n FROM employees e WHERE ${clause}`).get(...values)![
          'n'
        ],
      );
    const items = this.db
      .prepare(
        `SELECT ${employeeColumns} FROM employees e ${employeeJoins} WHERE ${clause} ORDER BY e.display_name,e.id LIMIT ? OFFSET ?`,
      )
      .all(
        ...values,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as unknown as EmploymentRecord[];
    return { items, total, page: input.page, pageSize: input.pageSize };
  }
  private employee(actor: Actor, employeeId: string): EmploymentRecord {
    const row = this.db
      .prepare(
        `SELECT ${employeeColumns} FROM employees e ${employeeJoins} WHERE e.organization_id=? AND e.id=?`,
      )
      .get(actor.organizationId, employeeId);
    if (!row) throw new OrganizationDomainError(404, 'EMPLOYEE_NOT_FOUND');
    return row as unknown as EmploymentRecord;
  }
  createEmployee(actor: Actor, raw: unknown): EmploymentRecord {
    const input = employeeInput.parse(raw);
    return this.transaction(actor, () => {
      const employeeId = randomUUID();
      this.db
        .prepare(
          'INSERT INTO employees(id,organization_id,display_name,email,role,team,employee_number,employment_type) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          employeeId,
          actor.organizationId,
          input.displayName,
          input.email,
          'EMPLOYEE',
          'Unassigned',
          input.employeeNumber,
          input.employmentType,
        );
      const result = this.employee(actor, employeeId);
      this.audit(actor, 'EMPLOYEE_CREATED', 'employee', employeeId, null, result);
      return result;
    });
  }
  updateEmployee(actor: Actor, employeeId: string, raw: unknown): EmploymentRecord {
    id.parse(employeeId);
    const input = employeeInput
      .extend({
        version: z.number().int().positive(),
        employmentStatus: z.enum(['active', 'inactive']),
      })
      .parse(raw);
    return this.transaction(actor, () => {
      const before = this.employee(actor, employeeId);
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'EMPLOYEE_VERSION_CONFLICT');
      if (employeeId === actor.id && input.employmentStatus === 'inactive')
        throw new OrganizationDomainError(403, 'SELF_DEACTIVATION_FORBIDDEN');
      this.db
        .prepare(
          'UPDATE employees SET display_name=?,email=?,employee_number=?,employment_type=?,employment_status=?,version=version+1 WHERE organization_id=? AND id=?',
        )
        .run(
          input.displayName,
          input.email,
          input.employeeNumber,
          input.employmentType,
          input.employmentStatus,
          actor.organizationId,
          employeeId,
        );
      if (input.employmentStatus === 'inactive') {
        this.revokeSessions(employeeId);
        this.db
          .prepare(
            'UPDATE employee_position_assignments SET ended_at=? WHERE organization_id=? AND employee_id=? AND ended_at IS NULL',
          )
          .run(new Date().toISOString(), actor.organizationId, employeeId);
        this.db
          .prepare(
            "UPDATE organization_memberships SET membership_status='suspended',version=version+1,updated_at=? WHERE organization_id=? AND employee_id=? AND membership_status='active'",
          )
          .run(new Date().toISOString(), actor.organizationId, employeeId);
      }
      const result = this.employee(actor, employeeId);
      this.audit(actor, 'EMPLOYEE_UPDATED', 'employee', employeeId, before, result);
      return result;
    });
  }
  assignPosition(actor: Actor, employeeId: string, raw: unknown): EmploymentRecord {
    id.parse(employeeId);
    const input = z
      .object({ positionId: id.nullable(), version: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.transaction(actor, () => {
      const before = this.employee(actor, employeeId);
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'EMPLOYEE_VERSION_CONFLICT');
      if (before.employmentStatus !== 'active')
        throw new OrganizationDomainError(409, 'EMPLOYEE_INACTIVE');
      if (input.positionId) {
        const position = this.db
          .prepare("SELECT id FROM positions WHERE organization_id=? AND id=? AND status='active'")
          .get(actor.organizationId, input.positionId);
        if (!position) throw new OrganizationDomainError(404, 'POSITION_NOT_FOUND');
        if (before.positionId === input.positionId) return before;
        const occupied = this.db
          .prepare(
            'SELECT employee_id FROM employee_position_assignments WHERE organization_id=? AND position_id=? AND ended_at IS NULL',
          )
          .get(actor.organizationId, input.positionId);
        if (occupied) throw new OrganizationDomainError(409, 'POSITION_OCCUPIED');
      }
      const time = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE employee_position_assignments SET ended_at=? WHERE organization_id=? AND employee_id=? AND ended_at IS NULL',
        )
        .run(time, actor.organizationId, employeeId);
      if (input.positionId)
        this.db
          .prepare('INSERT INTO employee_position_assignments VALUES (?,?,?,?,?,NULL,?)')
          .run(randomUUID(), actor.organizationId, employeeId, input.positionId, time, actor.id);
      this.db
        .prepare('UPDATE employees SET version=version+1 WHERE organization_id=? AND id=?')
        .run(actor.organizationId, employeeId);
      const after = this.employee(actor, employeeId);
      this.audit(actor, 'EMPLOYEE_POSITION_CHANGED', 'employee', employeeId, before, after);
      return after;
    });
  }
  listMemberships(actor: Actor, raw: unknown): Page<OrganizationMembership> {
    this.security.authorize(actor);
    const input = pageInput.pick({ page: true, pageSize: true, search: true }).parse(raw),
      where =
        'm.organization_id=? AND (instr(lower(e.display_name),lower(?))>0 OR instr(lower(u.email),lower(?))>0)';
    const total = Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM organization_memberships m JOIN employees e ON e.id=m.employee_id JOIN users u ON u.id=m.user_id WHERE ${where}`,
        )
        .get(actor.organizationId, input.search, input.search)!['n'],
    );
    const items = this.db
      .prepare(
        `SELECT m.id,m.user_id AS userId,m.employee_id AS employeeId,e.display_name AS displayName,u.email,m.security_role AS securityRole,m.membership_status AS membershipStatus,m.version FROM organization_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id JOIN users u ON u.id=m.user_id WHERE ${where} ORDER BY e.display_name,m.id LIMIT ? OFFSET ?`,
      )
      .all(
        actor.organizationId,
        input.search,
        input.search,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as unknown as OrganizationMembership[];
    return { items, total, page: input.page, pageSize: input.pageSize };
  }
  setMembershipStatus(actor: Actor, membershipId: string, raw: unknown): OrganizationMembership {
    id.parse(membershipId);
    const input = z
      .object({ status: z.enum(['active', 'suspended']), version: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.transaction(actor, () => {
      const row = this.db
        .prepare(
          `SELECT m.id,m.employee_id,m.membership_status,m.version,e.employment_status,u.status AS user_status,
        EXISTS(SELECT 1 FROM identities i WHERE i.employee_id=e.id AND i.user_id=m.user_id AND i.enabled=1) AS enabled,
        EXISTS(SELECT 1 FROM password_credentials c WHERE c.issuer=? AND c.subject=e.id) AS has_password
        FROM organization_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id
        JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=? AND m.id=?`,
        )
        .get(LOCAL_ISSUER, actor.organizationId, membershipId);
      if (!row) throw new OrganizationDomainError(404, 'MEMBERSHIP_NOT_FOUND');
      if (row['version'] !== input.version)
        throw new OrganizationDomainError(409, 'MEMBERSHIP_VERSION_CONFLICT');
      if (row['employee_id'] === actor.id)
        throw new OrganizationDomainError(403, 'SELF_ROLE_CHANGE_FORBIDDEN');
      if (
        input.status === 'active' &&
        (row['employment_status'] !== 'active' ||
          row['user_status'] !== 'active' ||
          (row['enabled'] !== 1 && row['has_password'] !== 1))
      )
        throw new OrganizationDomainError(409, 'MEMBERSHIP_NOT_READY');
      if (input.status === 'active' && row['enabled'] !== 1)
        this.db
          .prepare('UPDATE identities SET enabled=1 WHERE issuer=? AND employee_id=?')
          .run(LOCAL_ISSUER, row['employee_id']);
      if (input.status === 'suspended') this.revokeSessions(String(row['employee_id']));
      this.db
        .prepare(
          'UPDATE organization_memberships SET membership_status=?,version=version+1,updated_at=? WHERE organization_id=? AND id=?',
        )
        .run(input.status, new Date().toISOString(), actor.organizationId, membershipId);
      const after = this.db
        .prepare(
          `SELECT m.id,m.user_id AS userId,m.employee_id AS employeeId,e.display_name AS displayName,u.email,m.security_role AS securityRole,m.membership_status AS membershipStatus,m.version FROM organization_memberships m JOIN employees e ON e.id=m.employee_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.id=?`,
        )
        .get(actor.organizationId, membershipId) as unknown as OrganizationMembership;
      this.audit(
        actor,
        input.status === 'active' ? 'MEMBERSHIP_REACTIVATED' : 'MEMBERSHIP_SUSPENDED',
        'organization_membership',
        membershipId,
        row,
        after,
      );
      return after;
    });
  }
}
