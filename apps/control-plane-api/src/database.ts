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
  ProvisioningInput,
  ProvisioningRequest,
  SignedAgentManifest,
  LifecycleEvent,
  Actor,
  AdminAgentInput,
  AgentAssignment,
} from '@agents-foundry/contracts';
import type { IdentityEntry } from './identity-directory.js';
import { ManifestSigner } from './manifest-signing.js';
import { qaBlueprint } from './blueprints.js';

const ORGANIZATION_ID = 'org_agents_foundry';
const EMPLOYEE_ID = 'employee_qa_demo';
const AGENT_ID = 'agent_qa_engineer';

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

  constructor(path = process.env['DATABASE_PATH'] ?? '.data/agents-foundry.db', seedDemo = true) {
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
    this.migrate();
    if (seedDemo) this.seed();
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
            'INSERT INTO identities (issuer, subject, employee_id, enabled) VALUES (?, ?, ?, 1) ON CONFLICT(issuer, subject) DO UPDATE SET enabled = 1',
          )
          .run(issuer, entry.subject, entry.employeeId);
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

  private insertInvitation(organizationId: string, member: NewMember, role: Actor['role']) {
    const email = member.email.trim().toLowerCase();
    if (this.db.prepare('SELECT id FROM employees WHERE lower(email) = ?').get(email))
      throw new Error('MEMBER_ALREADY_EXISTS');
    const employeeId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 48 * 3600000;
    this.db
      .prepare(
        'INSERT INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(employeeId, organizationId, member.displayName, email, role, member.team);
    this.db
      .prepare('INSERT INTO identities (issuer, subject, employee_id, enabled) VALUES (?, ?, ?, 0)')
      .run(LOCAL_ISSUER, employeeId, employeeId);
    this.db
      .prepare(
        'INSERT INTO invitations (hash, employee_id, expires_at, consumed) VALUES (?, ?, ?, 0)',
      )
      .run(createHash('sha256').update(token).digest('hex'), employeeId, expiresAt);
    return { employeeId, token, expiresAt };
  }

  inviteEmployee(actor: Actor, member: NewMember) {
    if (actor.role !== 'ADMIN') throw new Error('ACTOR_FORBIDDEN');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.insertInvitation(actor.organizationId, member, 'EMPLOYEE');
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
        .prepare('UPDATE identities SET enabled = 1 WHERE issuer = ? AND subject = ?')
        .run(LOCAL_ISSUER, employeeId);
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
      CASE WHEN i.enabled = 1 THEN 'ACTIVE'
      WHEN EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0 AND v.expires_at > ?) THEN 'INVITED'
      WHEN EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0) THEN 'INVITATION_EXPIRED'
      ELSE 'INACTIVE' END AS status
      FROM employees e JOIN identities i ON i.employee_id = e.id AND i.issuer = ?
      WHERE e.organization_id = ? ORDER BY e.display_name`,
      )
      .all(Date.now(), LOCAL_ISSUER, organizationId);
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
        .prepare('DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?')
        .run(LOCAL_ISSUER, employeeId);
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
          `SELECT e.role, i.enabled,
        EXISTS (SELECT 1 FROM password_credentials p WHERE p.issuer = i.issuer AND p.subject = i.subject) AS has_password,
        EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0) AS has_invitation
        FROM employees e JOIN identities i ON i.employee_id = e.id AND i.issuer = ?
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
        .prepare('UPDATE password_resets SET consumed = 1 WHERE employee_id = ?')
        .run(reset.employee_id);
      this.db
        .prepare('DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?')
        .run(LOCAL_ISSUER, reset.employee_id);
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

  findIdentity(issuer: string, subject: string): Actor | undefined {
    const row = this.db
      .prepare(
        'SELECT e.id, e.organization_id, e.role FROM identities i JOIN employees e ON e.id = i.employee_id WHERE i.issuer = ? AND i.subject = ? AND i.enabled = 1',
      )
      .get(issuer, subject) as
      { id: string; organization_id: string; role: Actor['role'] } | undefined;
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role } : undefined;
  }

  findPasswordIdentity(
    issuer: string,
    email: string,
  ): { subject: string; hash: string } | undefined {
    const rows = this.db
      .prepare(
        `SELECT i.subject, p.hash FROM identities i
      JOIN employees e ON e.id = i.employee_id
      JOIN password_credentials p ON p.issuer = i.issuer AND p.subject = i.subject
      WHERE i.issuer = ? AND i.enabled = 1 AND lower(e.email) = ?`,
      )
      .all(issuer, email.toLowerCase()) as unknown as { subject: string; hash: string }[];
    return rows.length === 1 ? rows[0] : undefined;
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
    this.db
      .prepare('INSERT INTO auth_sessions (hash, issuer, subject, expires_at) VALUES (?, ?, ?, ?)')
      .run(hash, issuer, subject, expiresAt);
  }
  deleteSession(hash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(hash);
  }
  findSession(hash: string): Actor | undefined {
    const row = this.db
      .prepare('SELECT issuer, subject FROM auth_sessions WHERE hash = ? AND expires_at > ?')
      .get(hash, Date.now()) as { issuer: string; subject: string } | undefined;
    return row ? this.findIdentity(row.issuer, row.subject) : undefined;
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
    const request: ProvisioningRequest = {
      ...input,
      id: randomUUID(),
      organizationId,
      employeeId,
      status: 'PENDING',
      capabilities: structuredClone(qaBlueprint.capabilities),
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
          `SELECT e.id FROM employees e JOIN identities i ON i.employee_id = e.id
      WHERE e.id = ? AND e.organization_id = ? AND e.role = 'ADMIN' AND i.issuer = ? AND i.enabled = 1`,
        )
        .get(actor.id, actor.organizationId, LOCAL_ISSUER)
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
      // Check every recipient before creating anything; invitations and disabled users are ineligible.
      const recipients = input.employeeIds.map((employeeId) => {
        const employee = this.db
          .prepare(
            `SELECT e.id, e.display_name, e.team FROM employees e JOIN identities i ON i.employee_id = e.id
          WHERE e.id = ? AND e.organization_id = ? AND e.role = 'EMPLOYEE' AND i.issuer = ? AND i.enabled = 1`,
          )
          .get(employeeId, actor.organizationId, LOCAL_ISSUER) as
          { id: string; display_name: string; team: string } | undefined;
        if (!employee) throw new Error('ASSIGNMENT_RECIPIENT_FORBIDDEN');
        return employee;
      });
      const assignments: AgentAssignment[] = [];
      for (const employee of recipients) {
        const agentId = randomUUID(),
          createdAt = now();
        const manifest = this.signer.sign({
          apiVersion: 'agents-foundry/v1',
          manifestId: randomUUID(),
          agentId,
          organizationId: actor.organizationId,
          employeeId: employee.id,
          blueprint: { id: input.blueprintId, version: input.blueprintVersion },
          model: {
            provider: input.provider,
            model: input.model,
            credentialMode: input.credentialMode,
          },
          answers: input.answers,
          capabilities: structuredClone(qaBlueprint.capabilities),
          conversationSync: 'REQUIRED',
          policyVersion: 'foundation-approval-v1',
          issuedAt: createdAt,
        });
        if (!this.signer.verify(manifest)) throw new Error('MANIFEST_INVALID');
        this.db
          .prepare(
            'INSERT INTO agents (id, organization_id, name, department, team, status, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            agentId,
            actor.organizationId,
            input.name,
            qaBlueprint.department,
            employee.team,
            'ACTIVE',
            JSON.stringify(
              qaBlueprint.capabilities.filter((c) => c.outcome !== 'DENY').map((c) => c.action),
            ),
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
          { manifestId: manifest.payload.manifestId, keyId: manifest.keyId },
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
      let manifest: SignedAgentManifest | undefined;
      if (decision === 'APPROVED') {
        request.agentId = randomUUID();
        manifest = this.signer.sign({
          apiVersion: 'agents-foundry/v1',
          manifestId: randomUUID(),
          agentId: request.agentId,
          organizationId,
          employeeId: request.employeeId,
          blueprint: { id: request.blueprintId, version: request.blueprintVersion },
          model: {
            provider: request.provider,
            model: request.model,
            credentialMode: request.credentialMode,
          },
          answers: request.answers,
          capabilities: request.capabilities,
          conversationSync: 'REQUIRED',
          policyVersion: 'foundation-approval-v1',
          issuedAt: request.decidedAt!,
        });
        if (!this.signer.verify(manifest)) throw new Error('MANIFEST_INVALID');
        this.db
          .prepare(
            'INSERT INTO agents (id, organization_id, name, department, team, status, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            request.agentId,
            organizationId,
            `${qaBlueprint.title} · ${request.answers['projectName']}`,
            qaBlueprint.department,
            'QA',
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
            manifestId: manifest.payload.manifestId,
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

  getManifest(agentId: string, organizationId: string, employeeId?: string): SignedAgentManifest {
    const row = this.db
      .prepare(
        'SELECT body, employee_id FROM agent_manifests WHERE agent_id = ? AND organization_id = ?',
      )
      .get(agentId, organizationId) as { body: string; employee_id: string } | undefined;
    if (!row || (employeeId && row.employee_id !== employeeId))
      throw new Error('MANIFEST_NOT_FOUND');
    const manifest = JSON.parse(row.body) as SignedAgentManifest;
    if (!this.signer.verify(manifest)) throw new Error('MANIFEST_INVALID');
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
  ): { run: QaRun; approval: Approval } {
    const conversation = this.getConversation(input.conversationId, organizationId);
    if (conversation.employeeId !== input.employeeId) throw new Error('CONVERSATION_FORBIDDEN');
    if (conversation.agentId !== AGENT_ID || !allowDemo)
      this.getManifest(conversation.agentId, organizationId, input.employeeId);
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      run: this.getQaRun(runId, organizationId),
      approval: this.getApproval(approvalId, organizationId),
    };
  }

  listApprovals(organizationId = ORGANIZATION_ID, employeeId?: string): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
                risk, summary, status, decided_by, decided_at, created_at
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
    const approval = this.getApproval(id, organizationId);
    if (approval.requestedBy === actorId) throw new Error('SELF_APPROVAL_FORBIDDEN');
    if (approval.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(status, actorId, timestamp, id);
      const runStatus: QaRunStatus = status === 'APPROVED' ? 'READY' : 'REJECTED';
      this.db.prepare('UPDATE qa_runs SET status = ? WHERE approval_id = ?').run(runStatus, id);
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
                risk, summary, status, decided_by, decided_at, created_at FROM approvals WHERE id = ? AND organization_id = ?`,
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
      status: String(row['status']) as ApprovalStatus,
      ...(row['decided_by'] ? { decidedBy: String(row['decided_by']) } : {}),
      ...(row['decided_at'] ? { decidedAt: String(row['decided_at']) } : {}),
      createdAt: String(row['created_at']),
    };
  }
}
