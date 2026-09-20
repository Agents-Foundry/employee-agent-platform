import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
} from '@agents-foundry/contracts';
import { ManifestSigner } from './manifest-signing.js';
import { qaBlueprint } from './blueprints.js';

const ORGANIZATION_ID = 'org_agents_foundry';
const EMPLOYEE_ID = 'employee_qa_demo';
const AGENT_ID = 'agent_qa_engineer';

function now(): string {
  return new Date().toISOString();
}

export class ControlPlaneDatabase {
  private readonly db: DatabaseSync;
  readonly signer: ManifestSigner;

  constructor(path = process.env['DATABASE_PATH'] ?? '.data/agents-foundry.db') {
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
    this.seed();
  }

  resolveActor(id: string, role: string, organizationId: string) {
    // Explicit local-demo identities only. Replace with verified OIDC claims before deployment.
    if (organizationId !== ORGANIZATION_ID) throw new Error('ACTOR_FORBIDDEN');
    if (role === 'ADMIN' && id === 'admin_demo') return;
    if (role === 'EMPLOYEE' && id === EMPLOYEE_ID) return;
    throw new Error('ACTOR_FORBIDDEN');
  }

  requestProvisioning(employeeId: string, input: ProvisioningInput): ProvisioningRequest {
    if (employeeId !== EMPLOYEE_ID) throw new Error('ACTOR_FORBIDDEN');
    const request: ProvisioningRequest = {
      ...input,
      id: randomUUID(),
      organizationId: ORGANIZATION_ID,
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
      this.audit(employeeId, 'provisioning.requested', 'provisioning_request', request.id, {
        blueprintId: input.blueprintId,
        blueprintVersion: input.blueprintVersion,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return request;
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
        this.audit(actorId, 'agent.manifest.issued', 'agent', request.agentId, {
          manifestId: manifest.payload.manifestId,
          keyId: manifest.keyId,
        });
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
        "SELECT * FROM audit_events WHERE organization_id = ? AND event_type IN ('provisioning.requested', 'provisioning.approved', 'provisioning.rejected', 'agent.manifest.issued') ORDER BY rowid DESC LIMIT 100",
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

  getBootstrap(): BootstrapResponse {
    const organization = this.db
      .prepare('SELECT id, name, slug FROM organizations LIMIT 1')
      .get() as unknown as Organization;
    const employeeRow = this.db
      .prepare('SELECT id, organization_id, display_name, email, role, team FROM employees LIMIT 1')
      .get() as Record<string, unknown>;
    const agentRows = this.db
      .prepare(
        'SELECT id, organization_id, name, department, team, status, capabilities FROM agents',
      )
      .all() as Record<string, unknown>[];

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

  listConversations(employeeId: string): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT id, organization_id, employee_id, agent_id, title, created_at, updated_at
         FROM conversations WHERE employee_id = ? ORDER BY updated_at DESC`,
      )
      .all(employeeId) as Record<string, unknown>[];
    return rows.map((row) => this.mapConversation(row));
  }

  createConversation(employeeId: string, agentId: string, title: string): Conversation {
    if (agentId !== AGENT_ID) this.getManifest(agentId, ORGANIZATION_ID, employeeId);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, organization_id, employee_id, agent_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ORGANIZATION_ID, employeeId, agentId, title, timestamp, timestamp);
    this.audit(employeeId, 'conversation.created', 'conversation', id, { title });
    return this.getConversation(id);
  }

  getConversation(id: string): ConversationDetail {
    const row = this.db
      .prepare(
        `SELECT id, organization_id, employee_id, agent_id, title, created_at, updated_at
         FROM conversations WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('CONVERSATION_NOT_FOUND');

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
  ): ConversationMessage {
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
    this.audit(author, 'message.created', 'conversation', conversationId, { messageId: id });
    return { id, conversationId, author, content, createdAt: timestamp };
  }

  createQaRun(input: {
    employeeId: string;
    conversationId: string;
    storyKey: string;
    targetUrl: string;
    plan: string[];
    approvalSummary: string;
  }): { run: QaRun; approval: Approval } {
    const conversation = this.getConversation(input.conversationId);
    if (conversation.employeeId !== input.employeeId) throw new Error('CONVERSATION_FORBIDDEN');
    if (conversation.agentId !== AGENT_ID)
      this.getManifest(conversation.agentId, ORGANIZATION_ID, input.employeeId);
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
          ORGANIZATION_ID,
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
          ORGANIZATION_ID,
          input.employeeId,
          input.conversationId,
          input.storyKey,
          input.targetUrl,
          'AWAITING_APPROVAL',
          JSON.stringify(input.plan),
          approvalId,
          timestamp,
        );
      this.audit(input.employeeId, 'qa_run.requested', 'qa_run', runId, {
        storyKey: input.storyKey,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { run: this.getQaRun(runId), approval: this.getApproval(approvalId) };
  }

  listApprovals(): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
                risk, summary, status, decided_by, decided_at, created_at
         FROM approvals ORDER BY created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapApproval(row));
  }

  decideApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'PENDING'>,
    actorId: string,
  ): Approval {
    const timestamp = now();
    const approval = this.getApproval(id);
    if (approval.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
        .run(status, actorId, timestamp, id);
      const runStatus: QaRunStatus = status === 'APPROVED' ? 'READY' : 'REJECTED';
      this.db.prepare('UPDATE qa_runs SET status = ? WHERE approval_id = ?').run(runStatus, id);
      this.audit(actorId, `approval.${status.toLowerCase()}`, 'approval', id, {
        resourceId: approval.resourceId,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getApproval(id);
  }

  private getQaRun(id: string): QaRun {
    const row = this.db
      .prepare(
        `SELECT id, organization_id, employee_id, conversation_id, story_key, target_url,
                status, plan, approval_id, created_at FROM qa_runs WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
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

  private getApproval(id: string): Approval {
    const row = this.db
      .prepare(
        `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
                risk, summary, status, decided_by, decided_at, created_at FROM approvals WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('APPROVAL_NOT_FOUND');
    return this.mapApproval(row);
  }

  private migrate(): void {
    this.db.exec(`
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
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
         (id, organization_id, actor_id, event_type, resource_type, resource_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        ORGANIZATION_ID,
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
