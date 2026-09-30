import { randomBytes, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import type { Actor } from '@agents-foundry/contracts';
import type {
  OrganizationProfile,
  TenantDomain,
  EmploymentRecord,
  OrganizationMembership,
  SetupProgress,
  SetupStep,
} from '../../../../packages/contracts/src/tenancy.js';
import type { Page } from '../../../../packages/contracts/src/organization.js';
import { LOCAL_ISSUER } from '../onboarding-types.js';
import { constraintKind, type PgStore, type SqlParam } from '../db/pg-store.js';
import {
  OrganizationDomainError,
  OrganizationStructureService,
  contains,
} from './structure-service.js';
import { TenantDomainCache, type TenantDomainCacheOptions } from './tenant-domain-cache.js';

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
const profileColumns = `id,name,legal_name AS "legalName",code,slug,website,industry,country,timezone,locale,status,version,updated_at AS "updatedAt"`;
const domainColumns = `id,organization_id AS "organizationId",domain,domain_type AS "domainType",is_primary AS "isPrimary",verification_status AS "verificationStatus",verification_token AS "verificationToken",verified_at AS "verifiedAt",version`;
const employeeColumns = `e.id,e.organization_id AS "organizationId",e.user_id AS "userId",e.display_name AS "displayName",e.email,e.employee_number AS "employeeNumber",e.employment_type AS "employmentType",e.employment_status AS "employmentStatus",e.version,
 a.position_id AS "positionId",p.name AS "positionTitle",u.name AS "unitName",r.name AS "roleName",l.name AS "levelName"`;
const employeeJoins = `LEFT JOIN employee_position_assignments a ON a.organization_id=e.organization_id AND a.employee_id=e.id AND a.ended_at IS NULL
 LEFT JOIN positions p ON p.id=a.position_id AND p.organization_id=e.organization_id
 LEFT JOIN organizational_units u ON u.id=p.organizational_unit_id AND u.organization_id=e.organization_id
 LEFT JOIN roles r ON r.id=p.role_id AND r.organization_id=e.organization_id
 LEFT JOIN job_levels l ON l.id=p.job_level_id AND l.organization_id=e.organization_id`;
const membershipColumns = `m.id,m.user_id AS "userId",m.employee_id AS "employeeId",e.display_name AS "displayName",u.email,m.security_role AS "securityRole",m.membership_status AS "membershipStatus",m.version`;

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
  readonly domains: TenantDomainCache;
  constructor(
    private readonly db: PgStore,
    private readonly security: OrganizationStructureService,
    domainCache: TenantDomainCacheOptions = {},
  ) {
    this.domains = new TenantDomainCache(db, domainCache);
  }
  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.security.authorize(actor);
      return work();
    });
  }
  private async transaction<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    try {
      return await this.asAdmin(actor, work);
    } catch (error) {
      if (error instanceof OrganizationDomainError) throw error;
      const kind = constraintKind(error);
      if (kind === 'unique' || kind === 'check')
        throw new OrganizationDomainError(409, 'TENANT_RECORD_CONFLICT');
      throw error;
    }
  }
  private async audit(
    actor: Actor,
    action: string,
    type: string,
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
      type,
      resourceId,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      randomUUID(),
      new Date().toISOString(),
    );
  }
  /** Sessions of this employee's account in this organization; RLS limits it to the tenant. */
  private async revokeSessions(employeeId: string): Promise<void> {
    await this.db.run(
      'DELETE FROM auth_sessions WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id=? AND e.user_id=auth_sessions.user_id AND e.organization_id=auth_sessions.organization_id)',
      employeeId,
    );
  }
  profile(actor: Actor): Promise<OrganizationProfile> {
    return this.asAdmin(
      actor,
      async () =>
        (await this.db.get(
          `SELECT ${profileColumns} FROM organizations WHERE id=?`,
          actor.organizationId,
        )) as unknown as OrganizationProfile,
    );
  }
  setupProgress(actor: Actor): Promise<SetupProgress> {
    return this.asAdmin(actor, async () => {
      const organizationId = actor.organizationId;
      const exists = async (sql: string, ...values: SqlParam[]): Promise<boolean> =>
        Boolean(await this.db.get(`SELECT 1 FROM ${sql} LIMIT 1`, ...values));
      const profile = await this.profile(actor);
      const steps: SetupStep[] = [
        { id: 'profile', required: true, complete: Boolean(profile.legalName && profile.country) },
        {
          id: 'structure',
          required: true,
          complete: await exists(
            "organizational_units WHERE organization_id=? AND status='active'",
            organizationId,
          ),
        },
        {
          id: 'positions',
          required: true,
          complete: await exists(
            "positions WHERE organization_id=? AND status='active'",
            organizationId,
          ),
        },
        {
          id: 'people',
          required: true,
          complete: await exists(
            "employees WHERE organization_id=? AND id<>? AND employment_status='active'",
            organizationId,
            actor.id,
          ),
        },
        {
          id: 'assignments',
          required: true,
          complete: await exists(
            "employee_position_assignments a JOIN employees e ON e.id=a.employee_id AND e.organization_id=a.organization_id WHERE a.organization_id=? AND a.ended_at IS NULL AND e.id<>? AND e.employment_status='active'",
            organizationId,
            actor.id,
          ),
        },
        {
          id: 'employee_access',
          required: true,
          complete: await exists(
            "organization_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.security_role='EMPLOYEE' AND m.membership_status='active' AND e.employment_status='active' AND u.status='active'",
            organizationId,
          ),
        },
        {
          id: 'domain',
          required: false,
          complete: await exists(
            "organization_domains WHERE organization_id=? AND verification_status='verified'",
            organizationId,
          ),
        },
      ];
      return {
        completedRequired: steps.filter((step) => step.required && step.complete).length,
        totalRequired: steps.filter((step) => step.required).length,
        steps,
      };
    });
  }
  async updateProfile(actor: Actor, raw: unknown): Promise<OrganizationProfile> {
    const input = profileInput.parse(raw);
    return this.transaction(actor, async () => {
      const before = await this.profile(actor);
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'PROFILE_VERSION_CONFLICT');
      await this.db.run(
        `UPDATE organizations SET name=?,legal_name=?,code=?,slug=?,website=?,industry=?,country=?,timezone=?,locale=?,version=version+1,updated_at=?,updated_by=? WHERE id=?`,
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
      const after = await this.profile(actor);
      await this.audit(
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
  listDomains(actor: Actor): Promise<TenantDomain[]> {
    return this.asAdmin(actor, async () =>
      (
        (await this.db.all(
          `SELECT ${domainColumns} FROM organization_domains WHERE organization_id=? ORDER BY is_primary DESC,domain`,
          actor.organizationId,
        )) as unknown as TenantDomain[]
      ).map((row) => ({
        ...row,
        isPrimary: Boolean(row.isPrimary),
        verificationToken: row.verificationStatus === 'pending' ? row.verificationToken : null,
      })),
    );
  }
  async registerDomain(actor: Actor, raw: unknown): Promise<TenantDomain> {
    const input = domainInput.parse(raw),
      domain = hostname(input.domain);
    return this.transaction(actor, async () => {
      const domainId = randomUUID(),
        token = `af-verify=${randomBytes(24).toString('base64url')}`,
        time = new Date().toISOString();
      await this.db.run(
        `INSERT INTO organization_domains(id,organization_id,domain,domain_type,verification_token,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?)`,
        domainId,
        actor.organizationId,
        domain,
        input.domainType,
        token,
        time,
        time,
        actor.id,
      );
      const result = (await this.listDomains(actor)).find((item) => item.id === domainId)!;
      await this.audit(actor, 'DOMAIN_REGISTERED', 'organization_domain', domainId, null, {
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
    const current = await this.asAdmin(actor, () =>
      this.db.get(
        'SELECT domain,verification_token,verification_status,version FROM organization_domains WHERE organization_id=? AND id=?',
        actor.organizationId,
        domainId,
      ),
    );
    if (!current) throw new OrganizationDomainError(404, 'DOMAIN_NOT_FOUND');
    if (current['verification_status'] !== 'pending')
      throw new OrganizationDomainError(409, 'DOMAIN_STATE_CONFLICT');
    // DNS is looked up outside any transaction.
    let records: string[][];
    try {
      records = await lookup(`_agents-foundry-verification.${current['domain']}`);
    } catch {
      throw new OrganizationDomainError(409, 'DOMAIN_PROOF_NOT_FOUND');
    }
    if (!records.some((parts) => parts.join('') === current['verification_token']))
      throw new OrganizationDomainError(409, 'DOMAIN_PROOF_NOT_FOUND');
    const verified = await this.transaction(actor, async () => {
      const fresh = await this.db.get(
        'SELECT version,verification_token,verification_status FROM organization_domains WHERE organization_id=? AND id=?',
        actor.organizationId,
        domainId,
      );
      if (
        !fresh ||
        fresh['version'] !== current['version'] ||
        fresh['verification_token'] !== current['verification_token'] ||
        fresh['verification_status'] !== 'pending'
      )
        throw new OrganizationDomainError(409, 'DOMAIN_STATE_CONFLICT');
      const time = new Date().toISOString();
      await this.db.run(
        "UPDATE organization_domains SET verification_status='verified',verification_token='',verified_at=?,updated_at=?,version=version+1 WHERE organization_id=? AND id=?",
        time,
        time,
        actor.organizationId,
        domainId,
      );
      await this.audit(
        actor,
        'DOMAIN_VERIFIED',
        'organization_domain',
        domainId,
        { domain: current['domain'] },
        { verifiedAt: time },
      );
      return (await this.listDomains(actor)).find((item) => item.id === domainId)!;
    });
    // This instance may remember the host as unrecognized; the notification reaches the others.
    this.domains.invalidate();
    return verified;
  }
  async setPrimaryDomain(actor: Actor, domainId: string): Promise<TenantDomain> {
    id.parse(domainId);
    return this.transaction(actor, async () => {
      const current = await this.db.get(
        'SELECT domain,verification_status FROM organization_domains WHERE organization_id=? AND id=?',
        actor.organizationId,
        domainId,
      );
      if (!current) throw new OrganizationDomainError(404, 'DOMAIN_NOT_FOUND');
      if (current['verification_status'] !== 'verified')
        throw new OrganizationDomainError(409, 'DOMAIN_UNVERIFIED');
      await this.db.run(
        'UPDATE organization_domains SET is_primary=0,version=version+1 WHERE organization_id=? AND is_primary=1',
        actor.organizationId,
      );
      await this.db.run(
        'UPDATE organization_domains SET is_primary=1,version=version+1,updated_at=? WHERE organization_id=? AND id=?',
        new Date().toISOString(),
        actor.organizationId,
        domainId,
      );
      await this.audit(actor, 'DOMAIN_PRIMARY_CHANGED', 'organization_domain', domainId, null, {
        domain: current['domain'],
      });
      return (await this.listDomains(actor)).find((item) => item.id === domainId)!;
    });
  }
  /**
   * Which organization a verified host belongs to: cross-tenant by nature (platform scope).
   * Remembered per instance while change notifications are connected (ADR 0027).
   */
  async resolveVerifiedDomain(host: string): Promise<string | null> {
    let domain: string;
    try {
      domain = hostname(host);
    } catch {
      return null;
    }
    return this.domains.resolve(domain, async () => {
      const row = await this.db.platform(() =>
        this.db.get(
          "SELECT d.organization_id FROM organization_domains d JOIN organizations o ON o.id=d.organization_id AND o.status='active' WHERE lower(d.domain)=lower(?) AND d.verification_status='verified'",
          domain,
        ),
      );
      return row ? String(row['organization_id']) : null;
    });
  }
  listEmployees(actor: Actor, raw: unknown): Promise<Page<EmploymentRecord>> {
    return this.asAdmin(actor, async () => {
      const input = pageInput.parse(raw),
        where = [
          'e.organization_id=?',
          `(${contains('e.display_name')} OR ${contains('e.email')} OR ${contains("coalesce(e.employee_number,'')")})`,
        ];
      const values: SqlParam[] = [actor.organizationId, input.search, input.search, input.search];
      if (input.status !== 'all') {
        where.push('e.employment_status=?');
        values.push(input.status);
      }
      const clause = where.join(' AND '),
        total = Number(
          (await this.db.get(`SELECT count(*) AS n FROM employees e WHERE ${clause}`, ...values))![
            'n'
          ],
        );
      const items = (await this.db.all(
        `SELECT ${employeeColumns} FROM employees e ${employeeJoins} WHERE ${clause} ORDER BY e.display_name,e.id LIMIT ? OFFSET ?`,
        ...values,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      )) as unknown as EmploymentRecord[];
      return { items, total, page: input.page, pageSize: input.pageSize };
    });
  }
  private async employee(actor: Actor, employeeId: string): Promise<EmploymentRecord> {
    const row = await this.db.get(
      `SELECT ${employeeColumns} FROM employees e ${employeeJoins} WHERE e.organization_id=? AND e.id=?`,
      actor.organizationId,
      employeeId,
    );
    if (!row) throw new OrganizationDomainError(404, 'EMPLOYEE_NOT_FOUND');
    return row as unknown as EmploymentRecord;
  }
  async createEmployee(actor: Actor, raw: unknown): Promise<EmploymentRecord> {
    const input = employeeInput.parse(raw);
    return this.transaction(actor, async () => {
      const employeeId = randomUUID();
      await this.db.run(
        'INSERT INTO employees(id,organization_id,display_name,email,role,team,employee_number,employment_type) VALUES (?,?,?,?,?,?,?,?)',
        employeeId,
        actor.organizationId,
        input.displayName,
        input.email,
        'EMPLOYEE',
        'Unassigned',
        input.employeeNumber,
        input.employmentType,
      );
      const result = await this.employee(actor, employeeId);
      await this.audit(actor, 'EMPLOYEE_CREATED', 'employee', employeeId, null, result);
      return result;
    });
  }
  async updateEmployee(actor: Actor, employeeId: string, raw: unknown): Promise<EmploymentRecord> {
    id.parse(employeeId);
    const input = employeeInput
      .extend({
        version: z.number().int().positive(),
        employmentStatus: z.enum(['active', 'inactive']),
      })
      .parse(raw);
    return this.transaction(actor, async () => {
      const before = await this.employee(actor, employeeId);
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'EMPLOYEE_VERSION_CONFLICT');
      if (employeeId === actor.id && input.employmentStatus === 'inactive')
        throw new OrganizationDomainError(403, 'SELF_DEACTIVATION_FORBIDDEN');
      await this.db.run(
        'UPDATE employees SET display_name=?,email=?,employee_number=?,employment_type=?,employment_status=?,version=version+1 WHERE organization_id=? AND id=?',
        input.displayName,
        input.email,
        input.employeeNumber,
        input.employmentType,
        input.employmentStatus,
        actor.organizationId,
        employeeId,
      );
      if (input.employmentStatus === 'inactive') {
        await this.revokeSessions(employeeId);
        await this.db.run(
          'UPDATE employee_position_assignments SET ended_at=? WHERE organization_id=? AND employee_id=? AND ended_at IS NULL',
          new Date().toISOString(),
          actor.organizationId,
          employeeId,
        );
        await this.db.run(
          "UPDATE organization_memberships SET membership_status='suspended',version=version+1,updated_at=? WHERE organization_id=? AND employee_id=? AND membership_status='active'",
          new Date().toISOString(),
          actor.organizationId,
          employeeId,
        );
      }
      const result = await this.employee(actor, employeeId);
      await this.audit(actor, 'EMPLOYEE_UPDATED', 'employee', employeeId, before, result);
      return result;
    });
  }
  async assignPosition(actor: Actor, employeeId: string, raw: unknown): Promise<EmploymentRecord> {
    id.parse(employeeId);
    const input = z
      .object({ positionId: id.nullable(), version: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.transaction(actor, async () => {
      const before = await this.employee(actor, employeeId);
      if (before.version !== input.version)
        throw new OrganizationDomainError(409, 'EMPLOYEE_VERSION_CONFLICT');
      if (before.employmentStatus !== 'active')
        throw new OrganizationDomainError(409, 'EMPLOYEE_INACTIVE');
      if (input.positionId) {
        const position = await this.db.get(
          "SELECT id FROM positions WHERE organization_id=? AND id=? AND status='active'",
          actor.organizationId,
          input.positionId,
        );
        if (!position) throw new OrganizationDomainError(404, 'POSITION_NOT_FOUND');
        if (before.positionId === input.positionId) return before;
        const occupied = await this.db.get(
          'SELECT employee_id FROM employee_position_assignments WHERE organization_id=? AND position_id=? AND ended_at IS NULL',
          actor.organizationId,
          input.positionId,
        );
        if (occupied) throw new OrganizationDomainError(409, 'POSITION_OCCUPIED');
      }
      const time = new Date().toISOString();
      await this.db.run(
        'UPDATE employee_position_assignments SET ended_at=? WHERE organization_id=? AND employee_id=? AND ended_at IS NULL',
        time,
        actor.organizationId,
        employeeId,
      );
      if (input.positionId)
        await this.db.run(
          'INSERT INTO employee_position_assignments (id,organization_id,employee_id,position_id,started_at,ended_at,created_by) VALUES (?,?,?,?,?,NULL,?)',
          randomUUID(),
          actor.organizationId,
          employeeId,
          input.positionId,
          time,
          actor.id,
        );
      await this.db.run(
        'UPDATE employees SET version=version+1 WHERE organization_id=? AND id=?',
        actor.organizationId,
        employeeId,
      );
      const after = await this.employee(actor, employeeId);
      await this.audit(actor, 'EMPLOYEE_POSITION_CHANGED', 'employee', employeeId, before, after);
      return after;
    });
  }
  listMemberships(actor: Actor, raw: unknown): Promise<Page<OrganizationMembership>> {
    return this.asAdmin(actor, async () => {
      const input = pageInput.pick({ page: true, pageSize: true, search: true }).parse(raw),
        where = `m.organization_id=? AND (${contains('e.display_name')} OR ${contains('u.email')})`;
      const total = Number(
        (await this.db.get(
          `SELECT count(*) AS n FROM organization_memberships m JOIN employees e ON e.id=m.employee_id JOIN users u ON u.id=m.user_id WHERE ${where}`,
          actor.organizationId,
          input.search,
          input.search,
        ))!['n'],
      );
      const items = (await this.db.all(
        `SELECT ${membershipColumns} FROM organization_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id JOIN users u ON u.id=m.user_id WHERE ${where} ORDER BY e.display_name,m.id LIMIT ? OFFSET ?`,
        actor.organizationId,
        input.search,
        input.search,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      )) as unknown as OrganizationMembership[];
      return { items, total, page: input.page, pageSize: input.pageSize };
    });
  }
  async setMembershipStatus(
    actor: Actor,
    membershipId: string,
    raw: unknown,
  ): Promise<OrganizationMembership> {
    id.parse(membershipId);
    const input = z
      .object({ status: z.enum(['active', 'suspended']), version: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.transaction(actor, async () => {
      const row = await this.db.get(
        `SELECT m.id,m.employee_id,m.membership_status,m.version,e.employment_status,u.status AS user_status,
        EXISTS(SELECT 1 FROM account_password_credentials c WHERE c.user_id=m.user_id) AS has_password,
        EXISTS(SELECT 1 FROM identities i WHERE i.employee_id=e.id AND i.user_id=m.user_id AND i.enabled=1) AS enabled
        FROM organization_memberships m JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id
        JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=? AND m.id=?`,
        actor.organizationId,
        membershipId,
      );
      if (!row) throw new OrganizationDomainError(404, 'MEMBERSHIP_NOT_FOUND');
      if (row['version'] !== input.version)
        throw new OrganizationDomainError(409, 'MEMBERSHIP_VERSION_CONFLICT');
      if (row['employee_id'] === actor.id)
        throw new OrganizationDomainError(403, 'SELF_ROLE_CHANGE_FORBIDDEN');
      if (
        input.status === 'active' &&
        (row['employment_status'] !== 'active' ||
          row['user_status'] !== 'active' ||
          row['has_password'] !== true)
      )
        throw new OrganizationDomainError(409, 'MEMBERSHIP_NOT_READY');
      if (input.status === 'active' && row['enabled'] !== true)
        await this.db.run(
          'UPDATE identities SET enabled=1 WHERE issuer=? AND employee_id=?',
          LOCAL_ISSUER,
          String(row['employee_id']),
        );
      if (input.status === 'suspended') await this.revokeSessions(String(row['employee_id']));
      await this.db.run(
        'UPDATE organization_memberships SET membership_status=?,version=version+1,updated_at=? WHERE organization_id=? AND id=?',
        input.status,
        new Date().toISOString(),
        actor.organizationId,
        membershipId,
      );
      const after = (await this.db.get(
        `SELECT ${membershipColumns} FROM organization_memberships m JOIN employees e ON e.id=m.employee_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.id=?`,
        actor.organizationId,
        membershipId,
      )) as unknown as OrganizationMembership;
      await this.audit(
        actor,
        input.status === 'active' ? 'MEMBERSHIP_REACTIVATED' : 'MEMBERSHIP_SUSPENDED',
        'organization_membership',
        membershipId,
        { ...row, has_password: row['has_password'] ? 1 : 0, enabled: row['enabled'] ? 1 : 0 },
        after,
      );
      return after;
    });
  }
}
