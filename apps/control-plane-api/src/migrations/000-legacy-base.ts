/**
 * The control plane's original SQLite tables, created before numbered migrations existed.
 * Kept (unchanged) so the SQLite importer can bring any older database to version 11.
 */
export const legacyBaseSql = `
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
    `;
