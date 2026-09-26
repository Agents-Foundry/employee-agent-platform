import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { LOCAL_ISSUER, type NewMember } from './onboarding-types.js';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentDefinition,
  Approval,
  ApprovalStatus,
  BootstrapResponse,
  Conversation,
  ConversationDetail,
  ConversationMessage,
  Employee,
  Organization,
  QaRun,
  QaRunStatus,
  AgentRunStatus,
  ProvisioningInput,
  ProvisioningRequest,
  AnySignedAgentManifest,
  ResolvedBlueprintBundle,
  WorkflowDefinition,
  GenericQaRunResponse,
  TaskSpec,
  LifecycleEvent,
  Actor,
  AdminAgentInput,
  AgentAssignment,
  CatalogDefinitions,
} from '@agents-foundry/contracts';
import type { IdentityEntry } from './identity-directory.js';
import { ManifestSigner } from './manifest-signing.js';
import { migrateOrganization } from './migrations/index.js';
import { OrganizationStructureService } from './organization/structure-service.js';
import { JobArchitectureService } from './organization/job-service.js';
import { TenancyService } from './organization/tenancy-service.js';
import { ExecutionService } from './execution/execution-service.js';
import { RuntimeIdentityRegistry, type RuntimeIdentityConfig } from './runtime/runtime-identity.js';
import { RuntimeTransportService } from './runtime/runtime-transport-service.js';
import { ActionGateway } from './actions/action-gateway.js';
import { ActionPolicyService } from './actions/action-policy-service.js';
import { ConnectorService } from './actions/connector-service.js';
import { FileSecretStore, type SecretResolver } from './actions/secrets.js';
import { CatalogService, agentLabel } from './catalog/catalog-service.js';
import { InstallationService } from './catalog/installation-service.js';
import { OrganizationDomainError } from './organization/structure-service.js';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { buildManifestPayload, type ManifestIssue } from './agents/manifest-v2.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { parseSignedManifest } from '../../../packages/contracts/src/runtime/v1/schemas.js';

const ORGANIZATION_ID = 'org_agents_foundry';
const EMPLOYEE_ID = 'employee_qa_demo';
const AGENT_ID = 'agent_qa_engineer';
const QA_WORKFLOW = 'validate-story';

function now(): string {
  return new Date().toISOString();
}

interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  destination: string;
}
const demoEmployee: Actor = { id: EMPLOYEE_ID, role: 'EMPLOYEE', organizationId: ORGANIZATION_ID };

export class ControlPlaneDatabase {
  private readonly db: DatabaseSync;
  readonly signer: ManifestSigner;
  readonly structure: OrganizationStructureService;
  readonly jobs: JobArchitectureService;
  readonly tenancy: TenancyService;
  readonly execution: ExecutionService;
  readonly catalog: CatalogService;
  readonly installations: InstallationService;
  /** ADR 0004: new agents receive agents-foundry/v2 manifests only when explicitly enabled. */
  readonly manifestV2Issuance: boolean;
  /** Phase C: employees may start generic runs for runtimes only when explicitly enabled. */
  readonly genericRuntimeEnabled: boolean;
  /** Phase F: `/api/qa/runs` queues generic validate-story runs for eligible agents. */
  readonly qaGenericRuntimeEnabled: boolean;
  readonly runtimeIdentities: RuntimeIdentityRegistry;
  readonly runtimeTransport: RuntimeTransportService;
  readonly connectors: ConnectorService;
  readonly actionPolicies: ActionPolicyService;
  readonly actions: ActionGateway;

  constructor(
    path = process.env['DATABASE_PATH'] ?? '.data/agents-foundry.db',
    seedDemo = true,
    options: {
      manifestV2Issuance?: boolean;
      catalog?: CatalogDefinitions;
      genericRuntime?: boolean;
      qaGenericRuntime?: boolean;
      runtimeIdentities?: RuntimeIdentityConfig[];
      /** Connector secret store; defaults to the operator file at CONNECTOR_SECRETS_PATH. */
      secrets?: SecretResolver;
      /** Connector HTTP client (tests). */
      connectorFetch?: typeof fetch;
      /** Allow http and private hosts for connector URLs (local testing only). */
      allowPrivateConnectorUrls?: boolean;
    } = {},
  ) {
    this.genericRuntimeEnabled =
      options.genericRuntime ?? process.env['GENERIC_AGENT_RUNTIME_ENABLED'] === 'true';
    this.qaGenericRuntimeEnabled =
      options.qaGenericRuntime ?? process.env['QA_GENERIC_RUNTIME_ENABLED'] === 'true';
    this.runtimeIdentities = options.runtimeIdentities
      ? new RuntimeIdentityRegistry(options.runtimeIdentities)
      : RuntimeIdentityRegistry.fromEnvironment();
    this.manifestV2Issuance =
      options.manifestV2Issuance ?? process.env['AGENT_MANIFEST_V2_ISSUANCE_ENABLED'] === 'true';
    this.signer =
      path === ':memory:'
        ? new ManifestSigner()
        : ManifestSigner.fromFile(
            process.env['MANIFEST_SIGNING_KEY_PATH'] ?? `${path}.signing-key.pem`,
          );
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    try {
      this.migrate();
      migrateOrganization(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.structure = new OrganizationStructureService(this.db);
    this.jobs = new JobArchitectureService(this.db, this.structure);
    this.tenancy = new TenancyService(this.db, this.structure);
    // Validates and registers the shipped catalog; a mutated released version fails startup.
    try {
      this.catalog = new CatalogService(this.db, options.catalog ?? builtInCatalog);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.installations = new InstallationService(this.db, this.catalog, this.structure);
    this.execution = new ExecutionService(
      this.db,
      (agentId, organizationId, employeeId) =>
        this.getManifest(agentId, organizationId, employeeId),
      {
        resolveWorkflow: (manifest, workflowId) => this.pinnedWorkflow(manifest, workflowId),
        conversationMessage: (organizationId, conversationId, content) => {
          this.addMessage(conversationId, 'AGENT', content, organizationId);
        },
      },
    );
    const audit = (
      actorId: string,
      eventType: string,
      resourceType: string,
      resourceId: string,
      metadata: object,
      organizationId: string,
    ) => this.audit(actorId, eventType, resourceType, resourceId, metadata, organizationId);
    this.connectors = new ConnectorService(this.db, this.structure, audit, {
      allowPrivateNetwork: options.allowPrivateConnectorUrls ?? false,
    });
    this.actionPolicies = new ActionPolicyService(this.db, this.structure, audit);
    this.actions = new ActionGateway(this.db, this.execution, {
      loadManifest: (agentId, organizationId, employeeId) =>
        this.getManifest(agentId, organizationId, employeeId),
      bundle: (blueprintId, version) => this.catalog.bundle(blueprintId, version, 404),
      audit,
      connectors: this.connectors,
      policies: this.actionPolicies,
      secrets: options.secrets ?? new FileSecretStore(),
      signGrant: (payload) => this.signer.signExecutionGrant(payload),
      ...(options.connectorFetch ? { fetch: options.connectorFetch } : {}),
    });
    this.runtimeTransport = new RuntimeTransportService(this.db, this.execution, {
      gateway: this.actions,
      audit,
    });
    if (seedDemo) this.seed();
  }

  /** A workflow from the exact catalog bundle the manifest pins; undefined if anything differs. */
  pinnedWorkflow(
    manifest: AnySignedAgentManifest,
    workflowId: string,
  ): WorkflowDefinition | undefined {
    if (manifest.payload.apiVersion !== 'agents-foundry/v2') return undefined;
    const { blueprint } = manifest.payload.metadata;
    if (!blueprint.digest || !manifest.payload.workflows.includes(workflowId)) return undefined;
    let bundle: ResolvedBlueprintBundle;
    try {
      bundle = this.catalog.bundle(blueprint.id, blueprint.version, 404);
    } catch {
      return undefined;
    }
    if (bundle.digest !== blueprint.digest) return undefined;
    return bundle.workflows.find((workflow) => workflow.id === workflowId);
  }

  syncIdentities(issuer: string, entries: IdentityEntry[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE identities SET enabled = 0 WHERE issuer = ?').run(issuer);
      for (const entry of entries) {
        const current = this.db
          .prepare('SELECT organization_id FROM employees WHERE id = ?')
          .get(entry.employeeId) as { organization_id: string } | undefined;
        const identity = this.db
          .prepare('SELECT employee_id FROM identities WHERE issuer = ? AND subject = ?')
          .get(issuer, entry.subject) as { employee_id: string } | undefined;
        if (
          (current && current.organization_id !== entry.organization.id) ||
          (identity && identity.employee_id !== entry.employeeId)
        )
          throw new Error('IDENTITY_REASSIGNMENT_FORBIDDEN');
        this.db
          .prepare(
            'INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug',
          )
          .run(entry.organization.id, entry.organization.name, entry.organization.slug);
        this.db
          .prepare(
            'INSERT INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email, role = excluded.role, team = excluded.team',
          )
          .run(
            entry.employeeId,
            entry.organization.id,
            entry.displayName,
            entry.email,
            entry.role,
            entry.team,
          );
        this.db
          .prepare(
            'INSERT INTO identities (issuer, subject, employee_id, enabled, user_id) VALUES (?, ?, ?, 1, ?) ON CONFLICT(issuer, subject) DO UPDATE SET enabled = 1',
          )
          .run(
            issuer,
            entry.subject,
            entry.employeeId,
            this.ensureAccount(entry.employeeId, 'active'),
          );
        this.db
          .prepare(
            'UPDATE users SET email=?,display_name=? WHERE id=(SELECT user_id FROM employees WHERE id=?)',
          )
          .run(entry.email, entry.displayName, entry.employeeId);
        const credential = this.db
          .prepare('SELECT hash FROM password_credentials WHERE issuer = ? AND subject = ?')
          .get(issuer, entry.subject) as { hash: string } | undefined;
        if (credential?.hash !== entry.passwordHash) {
          this.db
            .prepare('DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?')
            .run(issuer, entry.subject);
          this.db
            .prepare('DELETE FROM password_credentials WHERE issuer = ? AND subject = ?')
            .run(issuer, entry.subject);
          if (entry.passwordHash)
            this.db
              .prepare('INSERT INTO password_credentials (issuer, subject, hash) VALUES (?, ?, ?)')
              .run(issuer, entry.subject, entry.passwordHash);
        }
      }
      this.db
        .prepare(
          'DELETE FROM auth_sessions WHERE issuer = ? AND subject IN (SELECT subject FROM identities WHERE issuer = ? AND enabled = 0)',
        )
        .run(issuer, issuer);
      this.db
        .prepare(
          `UPDATE organization_memberships SET membership_status='suspended',version=version+1,updated_at=?
        WHERE employee_id IN (SELECT employee_id FROM identities WHERE issuer=? AND enabled=0)
        AND NOT EXISTS(SELECT 1 FROM identities i WHERE i.employee_id=organization_memberships.employee_id AND i.enabled=1)`,
        )
        .run(now(), issuer);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createCustomer(organization: { name: string; slug: string }, admin: NewMember) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const organizationId = randomUUID();
      this.db
        .prepare('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)')
        .run(organizationId, organization.name, organization.slug);
      const invitation = this.insertInvitation(organizationId, admin, 'ADMIN');
      this.audit(
        'platform-operator',
        'organization.created',
        'organization',
        organizationId,
        {},
        organizationId,
      );
      this.db.exec('COMMIT');
      return { organizationId, ...invitation };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertInvitation(
    organizationId: string,
    member: NewMember,
    role: Actor['role'],
    invitedBy: string | null = null,
  ) {
    const email = member.email.trim().toLowerCase();
    if (
      this.db
        .prepare('SELECT id FROM employees WHERE organization_id=? AND email=? COLLATE NOCASE')
        .get(organizationId, email)
    )
      throw new Error('MEMBER_ALREADY_EXISTS');
    const existing = this.db
      .prepare(
        'SELECT u.id FROM users u JOIN account_password_credentials c ON c.user_id=u.id WHERE u.email=? COLLATE NOCASE AND u.status=?',
      )
      .get(email, 'active');
    if (
      !existing &&
      this.db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email)
    )
      throw new Error('ACCOUNT_NOT_ACTIVE');
    const employeeId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 48 * 3600000;
    this.db
      .prepare(
        'INSERT INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(employeeId, organizationId, member.displayName, email, role, member.team);
    if (existing)
      this.db.prepare('UPDATE employees SET user_id=? WHERE id=?').run(existing['id'], employeeId);
    const userId = this.ensureAccount(employeeId, 'pending');
    if (existing)
      this.db
        .prepare(
          'INSERT INTO account_link_invitations(hash,organization_id,employee_id,user_id,expires_at,invited_by) VALUES (?,?,?,?,?,?)',
        )
        .run(
          createHash('sha256').update(token).digest('hex'),
          organizationId,
          employeeId,
          userId,
          expiresAt,
          invitedBy,
        );
    else {
      this.db
        .prepare(
          'INSERT INTO identities (issuer, subject, employee_id, enabled, user_id) VALUES (?, ?, ?, 0, ?)',
        )
        .run(LOCAL_ISSUER, employeeId, employeeId, userId);
      this.db
        .prepare(
          'INSERT INTO invitations (hash, employee_id, expires_at, consumed) VALUES (?, ?, ?, 0)',
        )
        .run(createHash('sha256').update(token).digest('hex'), employeeId, expiresAt);
    }
    return {
      employeeId,
      token,
      expiresAt,
      purpose: existing ? ('link' as const) : ('activate' as const),
    };
  }

  private ensureAccount(employeeId: string, status: 'pending' | 'active'): string {
    const employee = this.db
      .prepare(
        'SELECT id,user_id,organization_id,email,display_name,role FROM employees WHERE id=?',
      )
      .get(employeeId)!;
    const userId = (employee['user_id'] as string | null) ?? randomUUID();
    if (!employee['user_id']) {
      // Never link accounts by an unverified email match. Existing account linking is a separate consent flow.
      if (
        this.db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(employee['email'])
      )
        throw new Error('MEMBER_ALREADY_EXISTS');
      this.db
        .prepare('INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)')
        .run(userId, employee['email'], employee['display_name'], now());
      this.db.prepare('UPDATE employees SET user_id=? WHERE id=?').run(userId, employeeId);
    }
    this.db
      .prepare(
        `INSERT INTO organization_memberships(id,organization_id,user_id,employee_id,security_role,membership_status,joined_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,user_id) DO UPDATE SET
      membership_status=excluded.membership_status,security_role=excluded.security_role,
      version=organization_memberships.version+CASE WHEN organization_memberships.membership_status<>excluded.membership_status OR organization_memberships.security_role<>excluded.security_role THEN 1 ELSE 0 END,
      updated_at=excluded.updated_at`,
      )
      .run(
        randomUUID(),
        employee['organization_id'],
        userId,
        employeeId,
        employee['role'],
        status,
        now(),
        now(),
      );
    return userId;
  }

  inviteEmployee(actor: Actor, member: NewMember) {
    this.structure.authorize(actor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.insertInvitation(actor.organizationId, member, 'EMPLOYEE', actor.id);
      this.audit(
        actor.id,
        'employee.invited',
        'employee',
        invitation.employeeId,
        {},
        actor.organizationId,
      );
      this.db.exec('COMMIT');
      return invitation;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  inviteExistingEmployee(actor: Actor, employeeId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.structure.authorize(actor);
      const employee = this.db
        .prepare(
          "SELECT user_id,email FROM employees WHERE organization_id=? AND id=? AND employment_status='active'",
        )
        .get(actor.organizationId, employeeId);
      if (!employee) throw new Error('MEMBER_NOT_FOUND');
      if (employee['user_id']) throw new Error('MEMBER_ALREADY_EXISTS');
      const existing = this.db
        .prepare(
          'SELECT u.id FROM users u JOIN account_password_credentials c ON c.user_id=u.id WHERE u.email=? COLLATE NOCASE AND u.status=?',
        )
        .get(employee['email'], 'active');
      if (
        !existing &&
        this.db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(employee['email'])
      )
        throw new Error('ACCOUNT_NOT_ACTIVE');
      if (existing)
        this.db
          .prepare('UPDATE employees SET user_id=? WHERE id=?')
          .run(existing['id'], employeeId);
      const userId = this.ensureAccount(employeeId, 'pending');
      const token = randomBytes(32).toString('base64url'),
        expiresAt = Date.now() + 48 * 3600000;
      if (existing)
        this.db
          .prepare(
            'INSERT INTO account_link_invitations(hash,organization_id,employee_id,user_id,expires_at,invited_by) VALUES (?,?,?,?,?,?)',
          )
          .run(
            createHash('sha256').update(token).digest('hex'),
            actor.organizationId,
            employeeId,
            userId,
            expiresAt,
            actor.id,
          );
      else {
        this.db
          .prepare(
            'INSERT INTO identities(issuer,subject,employee_id,enabled,user_id) VALUES (?,?,?,0,?)',
          )
          .run(LOCAL_ISSUER, employeeId, employeeId, userId);
        this.db
          .prepare('INSERT INTO invitations(hash,employee_id,expires_at,consumed) VALUES (?,?,?,0)')
          .run(createHash('sha256').update(token).digest('hex'), employeeId, expiresAt);
      }
      this.audit(actor.id, 'employee.invited', 'employee', employeeId, {}, actor.organizationId);
      this.db.exec('COMMIT');
      return {
        employeeId,
        token,
        expiresAt,
        purpose: existing ? ('link' as const) : ('activate' as const),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  acceptInvitation(hash: string, passwordHash: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.db
        .prepare(
          'SELECT employee_id FROM invitations WHERE hash = ? AND consumed = 0 AND expires_at > ?',
        )
        .get(hash, Date.now()) as { employee_id: string } | undefined;
      if (!invitation) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const employeeId = invitation.employee_id;
      const employee = this.db
        .prepare('SELECT organization_id FROM employees WHERE id = ?')
        .get(employeeId) as { organization_id: string };
      this.db.prepare('UPDATE invitations SET consumed = 1 WHERE employee_id = ?').run(employeeId);
      this.db
        .prepare('INSERT INTO password_credentials (issuer, subject, hash) VALUES (?, ?, ?)')
        .run(LOCAL_ISSUER, employeeId, passwordHash);
      this.db
        .prepare(
          'INSERT INTO account_password_credentials(user_id,hash,updated_at) SELECT user_id,?,? FROM employees WHERE id=?',
        )
        .run(passwordHash, now(), employeeId);
      this.db
        .prepare('UPDATE identities SET enabled = 1 WHERE issuer = ? AND subject = ?')
        .run(LOCAL_ISSUER, employeeId);
      this.db
        .prepare(
          "UPDATE organization_memberships SET membership_status='active',version=version+1,updated_at=? WHERE employee_id=? AND membership_status='pending'",
        )
        .run(now(), employeeId);
      this.audit(
        employeeId,
        'employee.activated',
        'employee',
        employeeId,
        {},
        employee.organization_id,
      );
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listMembers(organizationId: string) {
    return this.db
      .prepare(
        `SELECT e.id, e.display_name AS displayName, e.email, e.role, e.team,
      CASE WHEN m.membership_status='suspended' OR e.employment_status='inactive' THEN 'INACTIVE'
      WHEN m.membership_status='active' AND c.user_id IS NOT NULL THEN 'ACTIVE'
      WHEN EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0 AND v.expires_at > ?) THEN 'INVITED'
      WHEN EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0) THEN 'INVITATION_EXPIRED'
      WHEN EXISTS (SELECT 1 FROM account_link_invitations l WHERE l.employee_id=e.id AND l.consumed=0 AND l.expires_at>?) THEN 'INVITED'
      ELSE 'INACTIVE' END AS status
      FROM employees e LEFT JOIN identities i ON i.employee_id = e.id AND i.issuer = ?
      JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id
      LEFT JOIN account_password_credentials c ON c.user_id=m.user_id
      WHERE e.organization_id = ? ORDER BY e.display_name`,
      )
      .all(Date.now(), Date.now(), LOCAL_ISSUER, organizationId);
  }

  disableMember(actor: Actor, employeeId: string): void {
    if (actor.role !== 'ADMIN' || actor.id === employeeId) throw new Error('ACTOR_FORBIDDEN');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !this.db
          .prepare('SELECT id FROM employees WHERE id = ? AND organization_id = ? AND role = ?')
          .get(employeeId, actor.organizationId, 'EMPLOYEE')
      )
        throw new Error('MEMBER_NOT_FOUND');
      this.db
        .prepare('UPDATE identities SET enabled = 0 WHERE employee_id = ? AND issuer = ?')
        .run(employeeId, LOCAL_ISSUER);
      this.db
        .prepare(
          "UPDATE organization_memberships SET membership_status='suspended',version=version+1,updated_at=? WHERE organization_id=? AND employee_id=?",
        )
        .run(now(), actor.organizationId, employeeId);
      this.db
        .prepare('DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?')
        .run(LOCAL_ISSUER, employeeId);
      this.db
        .prepare(
          'DELETE FROM auth_sessions WHERE organization_id=? AND user_id=(SELECT user_id FROM employees WHERE id=?)',
        )
        .run(actor.organizationId, employeeId);
      this.db.prepare('UPDATE invitations SET consumed = 1 WHERE employee_id = ?').run(employeeId);
      this.db
        .prepare('UPDATE password_resets SET consumed = 1 WHERE employee_id = ?')
        .run(employeeId);
      this.audit(actor.id, 'employee.disabled', 'employee', employeeId, {}, actor.organizationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  issueEmployeeLink(actor: Actor, employeeId: string, purpose: 'activate' | 'reset') {
    if (actor.role !== 'ADMIN' || actor.id === employeeId) throw new Error('ACTOR_FORBIDDEN');
    return this.issueMemberLink(actor.organizationId, employeeId, purpose, actor.id, true);
  }

  // Only exposed through the operator CLI, never an HTTP route.
  issueOperatorLink(organizationId: string, employeeId: string, purpose: 'activate' | 'reset') {
    return this.issueMemberLink(organizationId, employeeId, purpose, 'platform-operator', false);
  }

  private issueMemberLink(
    organizationId: string,
    employeeId: string,
    purpose: 'activate' | 'reset',
    actorId: string,
    employeeOnly: boolean,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const target = this.db
        .prepare(
          `SELECT e.role, CASE WHEN m.membership_status='suspended' OR e.employment_status='inactive' THEN 0 ELSE i.enabled END AS enabled,
        EXISTS (SELECT 1 FROM password_credentials p WHERE p.issuer = i.issuer AND p.subject = i.subject) AS has_password,
        EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0) AS has_invitation
        FROM employees e JOIN identities i ON i.employee_id = e.id AND i.issuer = ?
        JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id
        WHERE e.organization_id = ? AND e.id = ?`,
        )
        .get(LOCAL_ISSUER, organizationId, employeeId) as
        | { role: Actor['role']; enabled: number; has_password: number; has_invitation: number }
        | undefined;
      if (!target || (employeeOnly && target.role !== 'EMPLOYEE'))
        throw new Error('MEMBER_NOT_FOUND');
      if (
        purpose === 'activate'
          ? target.enabled || target.has_password || !target.has_invitation
          : !target.enabled || !target.has_password
      )
        throw new Error('RECOVERY_STATE_CONFLICT');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + (purpose === 'activate' ? 48 : 1) * 3600000;
      // Purpose-specific tables ensure activation links cannot be used to reset passwords.
      const table = purpose === 'activate' ? 'invitations' : 'password_resets';
      this.db.prepare(`UPDATE ${table} SET consumed = 1 WHERE employee_id = ?`).run(employeeId);
      this.db
        .prepare(
          `INSERT INTO ${table} (hash, employee_id, expires_at, consumed) VALUES (?, ?, ?, 0)`,
        )
        .run(createHash('sha256').update(token).digest('hex'), employeeId, expiresAt);
      this.audit(
        actorId,
        purpose === 'activate' ? 'employee.invitation.reissued' : 'employee.password_reset.issued',
        'employee',
        employeeId,
        {},
        organizationId,
      );
      this.db.exec('COMMIT');
      return { employeeId, token, expiresAt, role: target.role };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resetPassword(hash: string, passwordHash: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const reset = this.db
        .prepare(
          `SELECT r.employee_id, e.organization_id FROM password_resets r
        JOIN employees e ON e.id = r.employee_id
        JOIN identities i ON i.employee_id = e.id AND i.issuer = ? AND i.enabled = 1
        JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.membership_status='active'
        JOIN password_credentials p ON p.issuer = i.issuer AND p.subject = i.subject
        WHERE r.hash = ? AND r.consumed = 0 AND r.expires_at > ?`,
        )
        .get(LOCAL_ISSUER, hash, Date.now()) as
        { employee_id: string; organization_id: string } | undefined;
      if (!reset) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare('UPDATE password_credentials SET hash = ? WHERE issuer = ? AND subject = ?')
        .run(passwordHash, LOCAL_ISSUER, reset.employee_id);
      this.db
        .prepare(
          'UPDATE account_password_credentials SET hash=?,updated_at=? WHERE user_id=(SELECT user_id FROM employees WHERE id=?)',
        )
        .run(passwordHash, now(), reset.employee_id);
      this.db
        .prepare('UPDATE password_resets SET consumed = 1 WHERE employee_id = ?')
        .run(reset.employee_id);
      this.db
        .prepare('DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?')
        .run(LOCAL_ISSUER, reset.employee_id);
      this.db
        .prepare(
          'DELETE FROM auth_sessions WHERE user_id=(SELECT user_id FROM employees WHERE id=?)',
        )
        .run(reset.employee_id);
      this.audit(
        reset.employee_id,
        'employee.password_reset.completed',
        'employee',
        reset.employee_id,
        {},
        reset.organization_id,
      );
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findIdentity(issuer: string, subject: string, organizationId?: string): Actor | undefined {
    const row = this.db
      .prepare(
        `SELECT e.id,e.organization_id,m.security_role AS role FROM identities i
         JOIN users u ON u.id=i.user_id AND u.status='active'
         JOIN employees e ON e.id=i.employee_id AND e.user_id=u.id AND e.employment_status='active'
         JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.user_id=u.id AND m.membership_status='active'
         JOIN organizations o ON o.id=m.organization_id AND o.status='active'
         WHERE i.issuer=? AND i.subject=? AND i.enabled=1 AND (? IS NULL OR e.organization_id=?)`,
      )
      .get(issuer, subject, organizationId ?? null, organizationId ?? null) as
      { id: string; organization_id: string; role: Actor['role'] } | undefined;
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role } : undefined;
  }

  findPasswordIdentity(
    issuer: string,
    email: string,
    organizationId?: string,
  ): { subject: string; hash: string } | undefined {
    const rows = this.db
      .prepare(
        `SELECT i.subject, p.hash FROM identities i
      JOIN employees e ON e.id = i.employee_id
      JOIN users u ON u.id=i.user_id AND u.id=e.user_id AND u.status='active'
      JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.user_id=u.id AND m.membership_status='active'
      JOIN organizations o ON o.id=e.organization_id AND o.status='active'
      JOIN password_credentials p ON p.issuer = i.issuer AND p.subject = i.subject
      WHERE i.issuer = ? AND i.enabled = 1 AND e.employment_status='active' AND lower(u.email) = ? AND (? IS NULL OR e.organization_id=?)`,
      )
      .all(
        issuer,
        email.toLowerCase(),
        organizationId ?? null,
        organizationId ?? null,
      ) as unknown as { subject: string; hash: string }[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  accountMembership(userId: string, organizationId: string): Actor | undefined {
    const row = this.db
      .prepare(
        `SELECT e.id,e.organization_id,m.security_role AS role FROM organization_memberships m
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id AND e.user_id=u.id AND e.employment_status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      WHERE m.user_id=? AND m.organization_id=? AND m.membership_status='active'`,
      )
      .get(userId, organizationId) as
      { id: string; organization_id: string; role: Actor['role'] } | undefined;
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role } : undefined;
  }

  findPasswordAccount(
    email: string,
    organizationId?: string,
    role?: Actor['role'],
  ): { userId: string; hash: string; organizationId: string } | undefined {
    const user = this.db
      .prepare(
        `SELECT u.id,c.hash FROM users u
      JOIN account_password_credentials c ON c.user_id=u.id
      WHERE u.email=? COLLATE NOCASE AND u.status='active'`,
      )
      .get(email.trim()) as { id: string; hash: string } | undefined;
    if (!user) return undefined;
    const memberships = this.db
      .prepare(
        `SELECT m.organization_id,m.security_role FROM organization_memberships m
      JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id AND e.employment_status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      WHERE m.user_id=? AND m.membership_status='active' AND (? IS NULL OR m.organization_id=?)
      ORDER BY m.joined_at,m.organization_id`,
      )
      .all(user.id, organizationId ?? null, organizationId ?? null);
    const selected = memberships.find((item) => item['security_role'] === role) ?? memberships[0];
    return selected
      ? { userId: user.id, hash: user.hash, organizationId: String(selected['organization_id']) }
      : undefined;
  }

  listAccountMemberships(actor: Actor, hostOrganizationId?: string) {
    return this.db
      .prepare(
        `SELECT m.organization_id AS organizationId,o.name AS organizationName,m.security_role AS role,e.id AS employeeId
      FROM employees current JOIN organization_memberships m ON m.user_id=current.user_id
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      JOIN employees e ON e.id=m.employee_id AND e.employment_status='active'
      WHERE current.id=? AND current.organization_id=? AND m.membership_status='active' AND (? IS NULL OR m.organization_id=?)
      ORDER BY o.name,m.organization_id`,
      )
      .all(actor.id, actor.organizationId, hostOrganizationId ?? null, hostOrganizationId ?? null);
  }

  accountSessionUser(hash: string): string | undefined {
    const row = this.db
      .prepare('SELECT user_id FROM auth_sessions WHERE hash=? AND issuer=? AND expires_at>?')
      .get(hash, LOCAL_ISSUER, Date.now());
    return row?.['user_id'] ? String(row['user_id']) : undefined;
  }

  createAccountSession(
    hash: string,
    userId: string,
    organizationId: string,
    expiresAt: number,
  ): Actor {
    const actor = this.accountMembership(userId, organizationId);
    if (!actor) throw new Error('MEMBERSHIP_REQUIRED');
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(Date.now());
    this.db
      .prepare(
        'INSERT INTO auth_sessions(hash,issuer,subject,expires_at,user_id,organization_id) VALUES (?,?,?,?,?,?)',
      )
      .run(hash, LOCAL_ISSUER, userId, expiresAt, userId, organizationId);
    return actor;
  }

  previewAccountLink(hash: string, userId: string) {
    return this.db
      .prepare(
        `SELECT l.organization_id AS organizationId,o.name AS organizationName,m.security_role AS role,l.expires_at AS expiresAt
      FROM account_link_invitations l JOIN organization_memberships m ON m.organization_id=l.organization_id AND m.employee_id=l.employee_id AND m.user_id=l.user_id
      JOIN employees e ON e.id=l.employee_id AND e.employment_status='active'
      JOIN organizations o ON o.id=l.organization_id AND o.status='active'
      WHERE l.hash=? AND l.user_id=? AND l.consumed=0 AND l.expires_at>? AND m.membership_status='pending'`,
      )
      .get(hash, userId, Date.now());
  }

  acceptAccountLink(hash: string, userId: string): Actor | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const preview = this.previewAccountLink(hash, userId);
      if (!preview) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      this.db
        .prepare(
          "UPDATE organization_memberships SET membership_status='active',version=version+1,updated_at=? WHERE organization_id=? AND user_id=? AND membership_status='pending'",
        )
        .run(now(), preview['organizationId'], userId);
      this.db.prepare('UPDATE account_link_invitations SET consumed=1 WHERE hash=?').run(hash);
      const actor = this.accountMembership(userId, String(preview['organizationId']));
      if (!actor) throw new Error('LINK_MEMBERSHIP_UNAVAILABLE');
      this.audit(
        actor.id,
        'account.linked',
        'organization_membership',
        actor.id,
        { userId },
        actor.organizationId,
      );
      this.db.exec('COMMIT');
      return actor;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createLogin(hash: string, transaction: LoginTransaction, expiresAt: number): void {
    this.db.prepare('DELETE FROM login_transactions WHERE expires_at <= ?').run(Date.now());
    this.db
      .prepare('INSERT INTO login_transactions (hash, body, expires_at) VALUES (?, ?, ?)')
      .run(hash, JSON.stringify(transaction), expiresAt);
  }
  discardLogin(hash: string): void {
    this.db.prepare('DELETE FROM login_transactions WHERE hash = ?').run(hash);
  }
  consumeLogin(hash: string): LoginTransaction | undefined {
    const row = this.db
      .prepare('DELETE FROM login_transactions WHERE hash = ? RETURNING body, expires_at')
      .get(hash) as { body: string; expires_at: number } | undefined;
    return row && row.expires_at > Date.now()
      ? (JSON.parse(row.body) as LoginTransaction)
      : undefined;
  }
  createSession(hash: string, issuer: string, subject: string, expiresAt: number): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    const identity = this.db
      .prepare(
        'SELECT i.user_id,e.organization_id FROM identities i JOIN employees e ON e.id=i.employee_id WHERE i.issuer=? AND i.subject=?',
      )
      .get(issuer, subject);
    this.db
      .prepare(
        'INSERT INTO auth_sessions (hash, issuer, subject, expires_at, user_id, organization_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        hash,
        issuer,
        subject,
        expiresAt,
        identity?.['user_id'] ?? null,
        identity?.['organization_id'] ?? null,
      );
  }
  deleteSession(hash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(hash);
  }
  findSession(hash: string, organizationId?: string): Actor | undefined {
    const row = this.db
      .prepare(
        'SELECT issuer, subject, user_id, organization_id FROM auth_sessions WHERE hash = ? AND expires_at > ?',
      )
      .get(hash, Date.now()) as { issuer: string; subject: string } | undefined;
    if (!row) return undefined;
    const scoped = row as typeof row & { user_id: string | null; organization_id: string | null };
    if (row.issuer === LOCAL_ISSUER && scoped.user_id && scoped.organization_id)
      return organizationId && organizationId !== scoped.organization_id
        ? undefined
        : this.accountMembership(scoped.user_id, scoped.organization_id);
    return this.findIdentity(row.issuer, row.subject, organizationId);
  }

  resolveActor(id: string, role: string, organizationId: string) {
    // Explicit local-demo identities only. Replace with verified OIDC claims before deployment.
    if (organizationId !== ORGANIZATION_ID) throw new Error('ACTOR_FORBIDDEN');
    if (role === 'ADMIN' && id === 'admin_demo') return;
    if (role === 'EMPLOYEE' && id === EMPLOYEE_ID) return;
    throw new Error('ACTOR_FORBIDDEN');
  }

  requestProvisioning(
    employeeId: string,
    input: ProvisioningInput,
    organizationId = ORGANIZATION_ID,
  ): ProvisioningRequest {
    if (
      !this.db
        .prepare(
          "SELECT id FROM employees WHERE id = ? AND organization_id = ? AND role = 'EMPLOYEE'",
        )
        .get(employeeId, organizationId)
    )
      throw new Error('ACTOR_FORBIDDEN');
    const bundle = this.catalog.bundle(input.blueprintId, input.blueprintVersion);
    const request: ProvisioningRequest = {
      ...input,
      answers: this.catalog.validateAnswers(bundle, input.answers, 'ALL'),
      id: randomUUID(),
      organizationId,
      employeeId,
      status: 'PENDING',
      capabilities: bundle.capabilities,
      createdAt: now(),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO provisioning_requests (id, organization_id, employee_id, body) VALUES (?, ?, ?, ?)',
        )
        .run(request.id, request.organizationId, employeeId, JSON.stringify(request));
      this.audit(
        employeeId,
        'provisioning.requested',
        'provisioning_request',
        request.id,
        {
          blueprintId: input.blueprintId,
          blueprintVersion: input.blueprintVersion,
        },
        organizationId,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return request;
  }

  createAssignedAgents(actor: Actor, input: AdminAgentInput): AgentAssignment[] {
    if (
      actor.role !== 'ADMIN' ||
      !this.db
        .prepare(
          `SELECT e.id FROM employees e
      JOIN organization_memberships m ON m.employee_id=e.id AND m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.membership_status='active'
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      JOIN account_password_credentials c ON c.user_id=u.id
      WHERE e.id = ? AND e.organization_id = ? AND m.security_role = 'ADMIN' AND e.employment_status='active'`,
        )
        .get(actor.id, actor.organizationId)
    )
      throw new Error('ACTOR_FORBIDDEN');
    const bodyHash = createHash('sha256')
      .update(JSON.stringify({ actorId: actor.id, ...input }))
      .digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db
        .prepare(
          'SELECT body_hash, result FROM admin_agent_batches WHERE organization_id = ? AND request_id = ?',
        )
        .get(actor.organizationId, input.requestId) as
        { body_hash: string; result: string } | undefined;
      if (previous) {
        if (previous.body_hash !== bodyHash) throw new Error('IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT');
        return JSON.parse(previous.result) as AgentAssignment[];
      }
      // Resolved after the replay check: an unchanged retry returns its original result even
      // if the installation was retired since. Retirement still blocks new agents (trigger).
      const bundle = this.catalog.bundle(input.blueprintId, input.blueprintVersion);
      const installation = input.installationId
        ? this.installations.activeInstallation(actor.organizationId, input.installationId)
        : null;
      if (
        installation &&
        (installation.blueprintId !== input.blueprintId ||
          installation.blueprintVersion !== input.blueprintVersion)
      )
        throw new OrganizationDomainError(409, 'INSTALLATION_BLUEPRINT_MISMATCH');
      const answers = this.catalog.resolveAnswers(bundle, installation, input.answers);
      // Check every recipient before creating anything; invitations and disabled users are ineligible.
      const recipients = input.employeeIds.map((employeeId) => {
        const employee = this.db
          .prepare(
            `SELECT e.id, e.display_name, e.team FROM employees e
          JOIN organization_memberships m ON m.employee_id=e.id AND m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.membership_status='active'
          JOIN users u ON u.id=m.user_id AND u.status='active'
          JOIN organizations o ON o.id=m.organization_id AND o.status='active'
          JOIN account_password_credentials c ON c.user_id=u.id
          WHERE e.id = ? AND e.organization_id = ? AND m.security_role = 'EMPLOYEE' AND e.employment_status='active'`,
          )
          .get(employeeId, actor.organizationId) as
          { id: string; display_name: string; team: string } | undefined;
        if (!employee) throw new Error('ASSIGNMENT_RECIPIENT_FORBIDDEN');
        return employee;
      });
      const assignments: AgentAssignment[] = [];
      for (const employee of recipients) {
        const agentId = randomUUID(),
          createdAt = now();
        const manifest = this.issueManifest({
          manifestId: randomUUID(),
          agentId,
          organizationId: actor.organizationId,
          employeeId: employee.id,
          issuedAt: createdAt,
          agentName: input.name,
          bundle,
          installationId: installation?.id ?? null,
          provider: input.provider,
          model: input.model,
          credentialMode: input.credentialMode,
          answers,
          capabilities: structuredClone(bundle.capabilities),
        });
        this.db
          .prepare(
            'INSERT INTO agents (id, organization_id, name, department, team, status, capabilities, installation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            agentId,
            actor.organizationId,
            input.name,
            bundle.blueprint.department,
            employee.team,
            'ACTIVE',
            JSON.stringify(
              bundle.capabilities.filter((c) => c.outcome !== 'DENY').map((c) => c.action),
            ),
            installation?.id ?? null,
          );
        this.db
          .prepare(
            'INSERT INTO agent_manifests (agent_id, organization_id, employee_id, body) VALUES (?, ?, ?, ?)',
          )
          .run(agentId, actor.organizationId, employee.id, JSON.stringify(manifest));
        this.db
          .prepare(
            'INSERT INTO agent_assignments (agent_id, created_by, created_at) VALUES (?, ?, ?)',
          )
          .run(agentId, actor.id, createdAt);
        this.audit(
          actor.id,
          'agent.admin_created',
          'agent',
          agentId,
          {
            blueprintId: input.blueprintId,
            blueprintVersion: input.blueprintVersion,
            blueprintDigest: bundle.digest,
            installationId: installation?.id ?? null,
            requestId: input.requestId,
          },
          actor.organizationId,
        );
        this.audit(
          actor.id,
          'agent.assigned',
          'agent',
          agentId,
          { employeeId: employee.id },
          actor.organizationId,
        );
        this.audit(
          actor.id,
          'agent.manifest.issued',
          'agent',
          agentId,
          {
            manifestId: manifestSubject(manifest.payload).manifestId,
            apiVersion: manifest.payload.apiVersion,
            keyId: manifest.keyId,
          },
          actor.organizationId,
        );
        assignments.push({
          agentId,
          name: input.name,
          employeeId: employee.id,
          employeeName: employee.display_name,
          createdBy: actor.id,
          createdAt,
        });
      }
      this.db
        .prepare(
          'INSERT INTO admin_agent_batches (organization_id, request_id, body_hash, result) VALUES (?, ?, ?, ?)',
        )
        .run(actor.organizationId, input.requestId, bodyHash, JSON.stringify(assignments));
      this.db.exec('COMMIT');
      return assignments;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listAgentAssignments(organizationId: string): AgentAssignment[] {
    return this.db
      .prepare(
        `SELECT a.id AS agentId, a.name, m.employee_id AS employeeId, e.display_name AS employeeName,
      s.created_by AS createdBy, s.created_at AS createdAt FROM agent_assignments s
      JOIN agents a ON a.id = s.agent_id JOIN agent_manifests m ON m.agent_id = a.id
      JOIN employees e ON e.id = m.employee_id WHERE a.organization_id = ? ORDER BY s.created_at DESC, a.id`,
      )
      .all(organizationId) as unknown as AgentAssignment[];
  }

  listProvisioning(organizationId: string, employeeId?: string): ProvisioningRequest[] {
    const rows = this.db
      .prepare(
        'SELECT body FROM provisioning_requests WHERE organization_id = ? ORDER BY rowid DESC',
      )
      .all(organizationId) as { body: string }[];
    return rows
      .map((row) => JSON.parse(row.body) as ProvisioningRequest)
      .filter((item) => !employeeId || item.employeeId === employeeId);
  }

  decideProvisioning(
    id: string,
    organizationId: string,
    actorId: string,
    decision: 'APPROVED' | 'REJECTED',
    reason: string,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT body FROM provisioning_requests WHERE id = ? AND organization_id = ?')
        .get(id, organizationId) as { body: string } | undefined;
      if (!row) throw new Error('PROVISIONING_NOT_FOUND');
      const request = JSON.parse(row.body) as ProvisioningRequest;
      if (request.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
      if (request.employeeId === actorId) throw new Error('SELF_APPROVAL_FORBIDDEN');
      Object.assign(request, {
        status: decision,
        decidedBy: actorId,
        decidedAt: now(),
        decisionReason: reason,
      });
      let manifest: AnySignedAgentManifest | undefined;
      if (decision === 'APPROVED') {
        request.agentId = randomUUID();
        const bundle = this.catalog.bundle(request.blueprintId, request.blueprintVersion);
        const agentName = agentLabel(bundle, request.answers);
        manifest = this.issueManifest({
          manifestId: randomUUID(),
          agentId: request.agentId,
          organizationId,
          employeeId: request.employeeId,
          issuedAt: request.decidedAt!,
          agentName,
          bundle,
          installationId: null,
          provider: request.provider,
          model: request.model,
          credentialMode: request.credentialMode,
          answers: request.answers,
          capabilities: request.capabilities,
        });
        this.db
          .prepare(
            'INSERT INTO agents (id, organization_id, name, department, team, status, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            request.agentId,
            organizationId,
            agentName,
            bundle.blueprint.department,
            this.employeeTeam(request.employeeId, organizationId),
            'ACTIVE',
            JSON.stringify(
              request.capabilities.filter((c) => c.outcome !== 'DENY').map((c) => c.action),
            ),
          );
        this.db
          .prepare(
            'INSERT INTO agent_manifests (agent_id, organization_id, employee_id, body) VALUES (?, ?, ?, ?)',
          )
          .run(request.agentId, organizationId, request.employeeId, JSON.stringify(manifest));
        this.audit(
          actorId,
          'agent.manifest.issued',
          'agent',
          request.agentId,
          {
            manifestId: manifestSubject(manifest.payload).manifestId,
            apiVersion: manifest.payload.apiVersion,
            keyId: manifest.keyId,
          },
          organizationId,
        );
      }
      this.db
        .prepare('UPDATE provisioning_requests SET body = ? WHERE id = ?')
        .run(JSON.stringify(request), id);
      this.audit(
        actorId,
        decision === 'APPROVED' ? 'provisioning.approved' : 'provisioning.rejected',
        'provisioning_request',
        id,
        { agentId: request.agentId ?? null, reason },
        organizationId,
      );
      this.db.exec('COMMIT');
      return { request, ...(manifest ? { manifest } : {}) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private employeeTeam(employeeId: string, organizationId: string): string {
    const row = this.db
      .prepare('SELECT team FROM employees WHERE id = ? AND organization_id = ?')
      .get(employeeId, organizationId) as { team: string } | undefined;
    return row?.team ?? '';
  }

  private issueManifest(issue: ManifestIssue): AnySignedAgentManifest {
    const manifest = this.signer.sign(
      buildManifestPayload(issue, this.manifestV2Issuance),
    ) as AnySignedAgentManifest;
    if (!this.signer.verify(manifest)) throw new Error('MANIFEST_INVALID');
    return manifest;
  }

  /** Fails closed on unknown versions, malformed structure, bad signatures or rebinding. */
  getManifest(
    agentId: string,
    organizationId: string,
    employeeId?: string,
  ): AnySignedAgentManifest {
    const row = this.db
      .prepare(
        'SELECT body, employee_id FROM agent_manifests WHERE agent_id = ? AND organization_id = ?',
      )
      .get(agentId, organizationId) as { body: string; employee_id: string } | undefined;
    if (!row || (employeeId && row.employee_id !== employeeId))
      throw new Error('MANIFEST_NOT_FOUND');
    let manifest: AnySignedAgentManifest;
    try {
      manifest = parseSignedManifest(JSON.parse(row.body));
    } catch {
      throw new Error('MANIFEST_INVALID');
    }
    const subject = manifestSubject(manifest.payload);
    if (
      !this.signer.verify(manifest) ||
      subject.agentId !== agentId ||
      subject.organizationId !== organizationId ||
      subject.employeeId !== row.employee_id
    )
      throw new Error('MANIFEST_INVALID');
    return manifest;
  }

  listLifecycleEvents(organizationId: string): LifecycleEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM audit_events WHERE organization_id = ? AND event_type IN ('provisioning.requested', 'provisioning.approved', 'provisioning.rejected', 'agent.manifest.issued', 'organization.created', 'employee.invited', 'employee.activated', 'employee.disabled', 'employee.invitation.reissued', 'employee.password_reset.issued', 'employee.password_reset.completed', 'agent.admin_created', 'agent.assigned') ORDER BY rowid DESC LIMIT 100",
      )
      .all(organizationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row['id']),
      organizationId,
      actorId: String(row['actor_id']),
      type: String(row['event_type']) as LifecycleEvent['type'],
      subjectId: String(row['resource_id']),
      occurredAt: String(row['created_at']),
      data: JSON.parse(String(row['metadata'])),
    }));
  }

  close(): void {
    this.db.close();
  }

  getBootstrap(actor: Actor = demoEmployee, allowDemo = true): BootstrapResponse {
    const organization = this.db
      .prepare('SELECT id, name, slug FROM organizations WHERE id = ?')
      .get(actor.organizationId) as unknown as Organization;
    const employeeRow = this.db
      .prepare(
        'SELECT id, organization_id, display_name, email, role, team FROM employees WHERE id = ? AND organization_id = ?',
      )
      .get(actor.id, actor.organizationId) as Record<string, unknown>;
    if (!organization || !employeeRow) throw new Error('ACTOR_FORBIDDEN');
    const agentRows = this.db
      .prepare(
        `SELECT id, organization_id, name, department, team, status, capabilities FROM agents a WHERE organization_id = ?
         AND (? = 'ADMIN' OR EXISTS (SELECT 1 FROM agent_manifests m WHERE m.agent_id = a.id AND m.employee_id = ?) OR (? = 1 AND a.id = ?))
         AND (? = 1 OR a.id != ?)`,
      )
      .all(
        actor.organizationId,
        actor.role,
        actor.id,
        allowDemo ? 1 : 0,
        AGENT_ID,
        allowDemo ? 1 : 0,
        AGENT_ID,
      ) as Record<string, unknown>[];

    return {
      organization,
      employee: this.mapEmployee(employeeRow),
      agents: agentRows.map((row) => this.mapAgent(row)),
      keyPolicy: {
        allowedSources: ['EMPLOYEE_BYOK', 'ORGANIZATION_MANAGED'],
        defaultSource: 'ORGANIZATION_MANAGED',
        secretStorageRule:
          'Only an external vault reference may be stored; raw provider keys are prohibited.',
      },
    };
  }

  listConversations(employeeId: string, organizationId = ORGANIZATION_ID): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT id, organization_id, employee_id, agent_id, title, created_at, updated_at
         FROM conversations WHERE employee_id = ? AND organization_id = ? ORDER BY updated_at DESC`,
      )
      .all(employeeId, organizationId) as Record<string, unknown>[];
    return rows.map((row) => this.mapConversation(row));
  }

  createConversation(
    employeeId: string,
    agentId: string,
    title: string,
    organizationId = ORGANIZATION_ID,
    allowDemo = true,
  ): Conversation {
    if (
      !this.db
        .prepare('SELECT id FROM employees WHERE id = ? AND organization_id = ?')
        .get(employeeId, organizationId)
    )
      throw new Error('ACTOR_FORBIDDEN');
    if (
      !this.db
        .prepare("SELECT id FROM agents WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'")
        .get(agentId, organizationId)
    )
      throw new Error('AGENT_NOT_FOUND');
    if (agentId !== AGENT_ID || !allowDemo) this.getManifest(agentId, organizationId, employeeId);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, organization_id, employee_id, agent_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, organizationId, employeeId, agentId, title, timestamp, timestamp);
    this.audit(employeeId, 'conversation.created', 'conversation', id, { title }, organizationId);
    return this.getConversation(id, organizationId, employeeId);
  }

  getConversation(
    id: string,
    organizationId = ORGANIZATION_ID,
    employeeId?: string,
  ): ConversationDetail {
    const row = this.db
      .prepare(
        `SELECT id, organization_id, employee_id, agent_id, title, created_at, updated_at
         FROM conversations WHERE id = ? AND organization_id = ?`,
      )
      .get(id, organizationId) as Record<string, unknown> | undefined;
    if (!row || (employeeId && row['employee_id'] !== employeeId))
      throw new Error('CONVERSATION_NOT_FOUND');

    const messages = this.db
      .prepare(
        `SELECT id, conversation_id, author, content, created_at
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
      )
      .all(id) as Record<string, unknown>[];
    return {
      ...this.mapConversation(row),
      messages: messages.map((message) => this.mapMessage(message)),
    };
  }

  addMessage(
    conversationId: string,
    author: ConversationMessage['author'],
    content: string,
    organizationId = ORGANIZATION_ID,
    employeeId?: string,
  ): ConversationMessage {
    const conversation = this.getConversation(conversationId, organizationId, employeeId);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, conversationId, author, content, timestamp);
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(timestamp, conversationId);
    this.audit(
      author === 'EMPLOYEE' ? conversation.employeeId : 'agent-runtime',
      'message.created',
      'conversation',
      conversationId,
      { messageId: id },
      organizationId,
    );
    return { id, conversationId, author, content, createdAt: timestamp };
  }

  /**
   * Phase F: queue a generic `validate-story` run instead of the legacy static plan. Returns
   * null when the agent is not eligible (no v2 manifest, or the workflow is not in its pinned
   * catalog bundle); the caller then uses the legacy path, which executes nothing.
   */
  createGenericQaRun(
    input: {
      employeeId: string;
      conversationId: string;
      storyKey: string;
      targetUrl: string;
      instructions?: string;
    },
    organizationId: string,
    allowDemo: boolean,
  ): GenericQaRunResponse | null {
    const conversation = this.getConversation(input.conversationId, organizationId);
    if (conversation.employeeId !== input.employeeId) throw new Error('CONVERSATION_FORBIDDEN');
    if (conversation.agentId === AGENT_ID && allowDemo) return null;
    const manifest = this.getManifest(conversation.agentId, organizationId, input.employeeId);
    if (
      manifest.payload.apiVersion !== 'agents-foundry/v2' ||
      !this.pinnedWorkflow(manifest, QA_WORKFLOW)
    )
      return null;
    // Checked again by Policy v2 for every browser run; refused here so nothing is queued.
    const qaUrl = manifest.payload.configuration['qaUrl'];
    if (typeof qaUrl !== 'string' || new URL(qaUrl).origin !== new URL(input.targetUrl).origin)
      throw new OrganizationDomainError(400, 'TARGET_OUT_OF_SCOPE');
    const origin = new URL(input.targetUrl).origin;
    const task: TaskSpec = {
      objective:
        `Validate ${input.storyKey} against ${origin}: read the story and its acceptance ` +
        'criteria, check out the configured repository, run the Playwright checks, and file ' +
        'defects for failures you can evidence.',
      workflow: QA_WORKFLOW,
      workItem: { system: 'issue-tracker', key: input.storyKey },
      inputs: {
        targetUrl: input.targetUrl,
        ...(input.instructions ? { instructions: input.instructions } : {}),
      },
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.execution.createRun({
        organizationId,
        employeeId: input.employeeId,
        agentId: conversation.agentId,
        title: `${input.storyKey} QA validation`,
        task,
        manifest,
        conversation: { id: conversation.id, title: conversation.title },
      });
      this.audit(
        input.employeeId,
        'qa_run.requested',
        'agent_run',
        run.id,
        { storyKey: input.storyKey, mode: 'GENERIC_RUNTIME' },
        organizationId,
      );
      this.addMessage(
        conversation.id,
        'AGENT',
        `I queued the ${QA_WORKFLOW} workflow for ${input.storyKey}. Browser runs and defect ` +
          'filing will each wait for approval.',
        organizationId,
      );
      this.db.exec('COMMIT');
      return {
        mode: 'GENERIC_RUNTIME',
        agentRun: { id: run.id, threadId: run.threadId, status: run.status },
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createQaRun(
    input: {
      employeeId: string;
      conversationId: string;
      storyKey: string;
      targetUrl: string;
      plan: string[];
      approvalSummary: string;
    },
    organizationId = ORGANIZATION_ID,
    allowDemo = true,
  ): {
    run: QaRun;
    approval: Approval;
    agentRun: { id: string; threadId: string; status: AgentRunStatus };
  } {
    const conversation = this.getConversation(input.conversationId, organizationId);
    if (conversation.employeeId !== input.employeeId) throw new Error('CONVERSATION_FORBIDDEN');
    const manifest =
      conversation.agentId !== AGENT_ID || !allowDemo
        ? this.getManifest(conversation.agentId, organizationId, input.employeeId)
        : null;
    let agentRun: { id: string; threadId: string; status: AgentRunStatus };
    const runId = randomUUID();
    const approvalId = randomUUID();
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO approvals
           (id, organization_id, requested_by, action, resource_type, resource_id, risk, summary, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          approvalId,
          organizationId,
          input.employeeId,
          'qa.execute_playwright',
          'qa_run',
          runId,
          'MEDIUM',
          input.approvalSummary,
          'PENDING',
          timestamp,
        );
      this.db
        .prepare(
          `INSERT INTO qa_runs
           (id, organization_id, employee_id, conversation_id, story_key, target_url, status, plan, approval_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          organizationId,
          input.employeeId,
          input.conversationId,
          input.storyKey,
          input.targetUrl,
          'AWAITING_APPROVAL',
          JSON.stringify(input.plan),
          approvalId,
          timestamp,
        );
      this.audit(
        input.employeeId,
        'qa_run.requested',
        'qa_run',
        runId,
        {
          storyKey: input.storyKey,
        },
        organizationId,
      );
      // ADR 0003: the generic run is written in the same transaction as the legacy record.
      agentRun = this.execution.recordLegacyQaRun({
        organizationId,
        employeeId: input.employeeId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        qaRunId: runId,
        approvalId,
        storyKey: input.storyKey,
        targetUrl: input.targetUrl,
        plan: input.plan,
        approvalSummary: input.approvalSummary,
        manifest,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      run: this.getQaRun(runId, organizationId),
      approval: this.getApproval(approvalId, organizationId),
      agentRun,
    };
  }

  listApprovals(organizationId = ORGANIZATION_ID, employeeId?: string): Approval[] {
    this.actions.expireDue();
    const rows = this.db
      .prepare(
        `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
                risk, summary, status, decided_by, decided_at, created_at, run_id, step_id, expires_at
         FROM approvals WHERE organization_id = ? ORDER BY created_at DESC`,
      )
      .all(organizationId) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapApproval(row))
      .filter((item) => !employeeId || item.requestedBy === employeeId);
  }

  decideApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'PENDING'>,
    actorId: string,
    organizationId = ORGANIZATION_ID,
  ): Approval {
    const timestamp = now();
    this.actions.expireDue();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Read inside the write transaction so concurrent decisions cannot both succeed.
      const approval = this.getApproval(id, organizationId);
      if (approval.requestedBy === actorId) throw new Error('SELF_APPROVAL_FORBIDDEN');
      if (approval.status === 'EXPIRED') throw new Error('APPROVAL_EXPIRED');
      if (approval.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
      this.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(status, actorId, timestamp, id);
      const runStatus: QaRunStatus = status === 'APPROVED' ? 'READY' : 'REJECTED';
      this.db.prepare('UPDATE qa_runs SET status = ? WHERE approval_id = ?').run(runStatus, id);
      this.execution.onApprovalDecided(organizationId, id, status, actorId);
      this.audit(
        actorId,
        `approval.${status.toLowerCase()}`,
        'approval',
        id,
        {
          resourceId: approval.resourceId,
        },
        organizationId,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getApproval(id, organizationId);
  }

  private getQaRun(id: string, organizationId: string): QaRun {
    const row = this.db
      .prepare(
        `SELECT id, organization_id, employee_id, conversation_id, story_key, target_url,
                status, plan, approval_id, created_at FROM qa_runs WHERE id = ? AND organization_id = ?`,
      )
      .get(id, organizationId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('QA_RUN_NOT_FOUND');
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      employeeId: String(row['employee_id']),
      conversationId: String(row['conversation_id']),
      storyKey: String(row['story_key']),
      targetUrl: String(row['target_url']),
      status: String(row['status']) as QaRunStatus,
      plan: JSON.parse(String(row['plan'])) as string[],
      approvalId: String(row['approval_id']),
      createdAt: String(row['created_at']),
    };
  }

  private getApproval(id: string, organizationId: string): Approval {
    const row = this.db
      .prepare(
        `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
                risk, summary, status, decided_by, decided_at, created_at, run_id, step_id, expires_at FROM approvals WHERE id = ? AND organization_id = ?`,
      )
      .get(id, organizationId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('APPROVAL_NOT_FOUND');
    return this.mapApproval(row);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, employee_id TEXT NOT NULL, enabled INTEGER NOT NULL,
        PRIMARY KEY (issuer, subject), FOREIGN KEY (employee_id) REFERENCES employees(id)
      );
      CREATE TABLE IF NOT EXISTS login_transactions (hash TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS password_credentials (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY (issuer, subject), FOREIGN KEY (issuer, subject) REFERENCES identities(issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (
        hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        hash TEXT PRIMARY KEY, employee_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      );
      CREATE TABLE IF NOT EXISTS provisioning_requests (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, employee_id TEXT NOT NULL, body TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      );
      CREATE TABLE IF NOT EXISTS agent_manifests (
        agent_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, employee_id TEXT NOT NULL, body TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      );
      CREATE TABLE IF NOT EXISTS admin_agent_batches (
        organization_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (organization_id, request_id), FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS agent_assignments (
        agent_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id), FOREIGN KEY (created_by) REFERENCES employees(id)
      );
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, display_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, team TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
        department TEXT NOT NULL, team TEXT NOT NULL, status TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, employee_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (employee_id) REFERENCES employees(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, author TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, requested_by TEXT NOT NULL,
        action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        risk TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
        decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS qa_runs (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, employee_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, story_key TEXT NOT NULL, target_url TEXT NOT NULL,
        status TEXT NOT NULL, plan TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (approval_id) REFERENCES approvals(id)
      );
      CREATE TABLE IF NOT EXISTS llm_key_bindings (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, employee_id TEXT,
        provider TEXT NOT NULL, key_source TEXT NOT NULL, secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (length(secret_ref) > 0)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        metadata TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_employee ON conversations(employee_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);
    `);
  }

  private seed(): void {
    this.db
      .prepare('INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (?, ?, ?)')
      .run(ORGANIZATION_ID, 'Agents Foundry', 'agents-foundry');
    this.db
      .prepare(
        `INSERT OR IGNORE INTO employees
         (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        EMPLOYEE_ID,
        ORGANIZATION_ID,
        'QA Engineer',
        'qa.engineer@agents-foundry.local',
        'EMPLOYEE',
        'QA',
      );
    this.db
      .prepare(
        'INSERT OR IGNORE INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'admin_demo',
        ORGANIZATION_ID,
        'Demo Admin',
        'admin@agents-foundry.local',
        'ADMIN',
        'Administration',
      );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agents
         (id, organization_id, name, department, team, status, capabilities)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        AGENT_ID,
        ORGANIZATION_ID,
        'QA Engineer Agent',
        'Engineering',
        'QA',
        'ACTIVE',
        JSON.stringify(['jira.read', 'repository.read', 'qa.plan', 'qa.execute_playwright']),
      );
  }

  private audit(
    actorId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    metadata: object,
    organizationId = ORGANIZATION_ID,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
         (id, organization_id, actor_id, event_type, resource_type, resource_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        organizationId,
        actorId,
        eventType,
        resourceType,
        resourceId,
        JSON.stringify(metadata),
        now(),
      );
  }

  private mapEmployee(row: Record<string, unknown>): Employee {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      displayName: String(row['display_name']),
      email: String(row['email']),
      role: String(row['role']) as Employee['role'],
      team: String(row['team']),
    };
  }

  private mapAgent(row: Record<string, unknown>): AgentDefinition {
    const assignment = this.db
      .prepare('SELECT employee_id FROM agent_manifests WHERE agent_id = ?')
      .get(String(row['id'])) as { employee_id: string } | undefined;
    return {
      ...(assignment ? { employeeId: assignment.employee_id } : {}),
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      name: String(row['name']),
      department: String(row['department']),
      team: String(row['team']),
      status: String(row['status']) as AgentDefinition['status'],
      capabilities: JSON.parse(String(row['capabilities'])) as string[],
    };
  }

  private mapConversation(row: Record<string, unknown>): Conversation {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      employeeId: String(row['employee_id']),
      agentId: String(row['agent_id']),
      title: String(row['title']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private mapMessage(row: Record<string, unknown>): ConversationMessage {
    return {
      id: String(row['id']),
      conversationId: String(row['conversation_id']),
      author: String(row['author']) as ConversationMessage['author'],
      content: String(row['content']),
      createdAt: String(row['created_at']),
    };
  }

  private mapApproval(row: Record<string, unknown>): Approval {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      requestedBy: String(row['requested_by']),
      action: String(row['action']),
      resourceType: String(row['resource_type']),
      resourceId: String(row['resource_id']),
      risk: String(row['risk']) as Approval['risk'],
      summary: String(row['summary']),
      status: String(row['status']) as Approval['status'],
      ...(row['decided_by'] ? { decidedBy: String(row['decided_by']) } : {}),
      ...(row['decided_at'] ? { decidedAt: String(row['decided_at']) } : {}),
      createdAt: String(row['created_at']),
      ...(row['expires_at'] ? { expiresAt: String(row['expires_at']) } : {}),
      ...(row['run_id'] ? { runId: String(row['run_id']) } : {}),
      ...(row['step_id'] ? { stepId: String(row['step_id']) } : {}),
    };
  }
}
