/**
 * Execution grants (Architecture V2 Phase E, ADR 0013). Additive. One signed grant per action
 * request; grants are immutable and retained with the run history.
 */
export const executionGrantsSql = `
CREATE TABLE agent_execution_grants (
 grant_id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE REFERENCES agent_action_requests(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 run_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL,
 signed_grant TEXT NOT NULL CHECK(json_valid(signed_grant)),
 issued_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE TRIGGER agent_execution_grants_no_update BEFORE UPDATE ON agent_execution_grants
 BEGIN SELECT RAISE(ABORT,'EXECUTION_GRANTS_IMMUTABLE'); END;
CREATE TRIGGER agent_execution_grants_no_delete BEFORE DELETE ON agent_execution_grants
 BEGIN SELECT RAISE(ABORT,'EXECUTION_GRANTS_IMMUTABLE'); END;
`;
