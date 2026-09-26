import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExecuteOperationResponse, WorkspaceState } from '@agents-foundry/contracts';

export interface WorkspaceRecord {
  id: string;
  organizationId: string;
  employeeId: string;
  agentId: string;
  threadId: string;
  state: WorkspaceState;
}

type Scope = Pick<WorkspaceRecord, 'organizationId' | 'employeeId' | 'agentId' | 'threadId'>;

/**
 * Execution-runtime state: which grants were used (single use, with the stored response for
 * idempotent replay) and which workspace belongs to which (organization, employee, agent,
 * thread). The registry is what lets a lost workspace be detected instead of recreated.
 */
export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('RUNNING','DONE')),
        response TEXT CHECK(response IS NULL OR json_valid(response)),
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        UNIQUE(organization_id, employee_id, agent_id, thread_id)
      );
    `);
  }

  /** Claim a grant for execution. Returns the stored response for a completed replay. */
  claimGrant(
    grantId: string,
  ):
    | { kind: 'claimed' }
    | { kind: 'running' }
    | { kind: 'done'; response: ExecuteOperationResponse } {
    const inserted = this.db
      .prepare(
        `INSERT INTO grants (grant_id, state, started_at) VALUES (?, 'RUNNING', ?) ON CONFLICT DO NOTHING`,
      )
      .run(grantId, new Date().toISOString());
    if (inserted.changes === 1) return { kind: 'claimed' };
    const row = this.db
      .prepare('SELECT state, response FROM grants WHERE grant_id = ?')
      .get(grantId) as { state: string; response: string | null };
    return row.state === 'DONE' && row.response
      ? { kind: 'done', response: JSON.parse(row.response) as ExecuteOperationResponse }
      : { kind: 'running' };
  }

  completeGrant(grantId: string, response: ExecuteOperationResponse): void {
    this.db
      .prepare(
        `UPDATE grants SET state='DONE', response=?, completed_at=? WHERE grant_id=? AND state='RUNNING'`,
      )
      .run(JSON.stringify(response), new Date().toISOString(), grantId);
  }

  workspace(scope: Scope): WorkspaceRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workspaces WHERE organization_id=? AND employee_id=? AND agent_id=? AND thread_id=?`,
      )
      .get(scope.organizationId, scope.employeeId, scope.agentId, scope.threadId) as
      Record<string, string> | undefined;
    return row
      ? {
          id: row['id']!,
          organizationId: row['organization_id']!,
          employeeId: row['employee_id']!,
          agentId: row['agent_id']!,
          threadId: row['thread_id']!,
          state: row['state'] as WorkspaceState,
        }
      : null;
  }

  createWorkspace(scope: Scope): WorkspaceRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, organization_id, employee_id, agent_id, thread_id, state, created_at, last_used_at)
         VALUES (?,?,?,?,?,'READY',?,?)`,
      )
      .run(id, scope.organizationId, scope.employeeId, scope.agentId, scope.threadId, now, now);
    return { id, ...scope, state: 'READY' };
  }

  setWorkspaceState(id: string, state: WorkspaceState): void {
    this.db
      .prepare('UPDATE workspaces SET state=?, last_used_at=? WHERE id=?')
      .run(state, new Date().toISOString(), id);
  }

  close(): void {
    this.db.close();
  }
}
