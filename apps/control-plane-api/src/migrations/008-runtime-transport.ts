/**
 * Runtime transport (Architecture V2 Phase C, ADR 0011). Additive. Leases record which
 * authenticated runtime holds a run, request nonces make signed requests single-use, and
 * action requests keep an idempotent record of every governed-action decision.
 */
export const runtimeTransportSql = `
CREATE TABLE agent_run_leases (
 run_id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 session_id TEXT NOT NULL UNIQUE,
 runtime_id TEXT NOT NULL CHECK(length(runtime_id) BETWEEN 1 AND 120),
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','CLOSED')),
 last_command TEXT,
 claimed_at TEXT NOT NULL,
 heartbeat_at TEXT NOT NULL,
 lease_expires_at TEXT NOT NULL,
 closed_at TEXT,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE INDEX agent_run_leases_runtime ON agent_run_leases(runtime_id,state);
CREATE TRIGGER agent_run_leases_identity_immutable BEFORE UPDATE OF run_id,organization_id,claimed_at
 ON agent_run_leases BEGIN SELECT RAISE(ABORT,'LEASE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER agent_run_leases_closed_immutable BEFORE UPDATE ON agent_run_leases
 WHEN OLD.state='CLOSED' BEGIN SELECT RAISE(ABORT,'LEASE_CLOSED'); END;
CREATE TRIGGER agent_run_leases_no_delete BEFORE DELETE ON agent_run_leases
 BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_RETAINED'); END;

CREATE TABLE runtime_request_nonces (
 runtime_id TEXT NOT NULL,
 nonce TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(runtime_id,nonce)
);
CREATE INDEX runtime_request_nonces_expiry ON runtime_request_nonces(expires_at);

CREATE TABLE agent_action_requests (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 run_id TEXT NOT NULL,
 step_id TEXT NOT NULL,
 runtime_id TEXT NOT NULL,
 action TEXT NOT NULL,
 tool_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 decision TEXT NOT NULL CHECK(decision IN ('ALLOWED','DENIED','APPROVAL_REQUIRED')),
 risk TEXT NOT NULL CHECK(risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
 reason TEXT NOT NULL,
 approval_id TEXT REFERENCES approvals(id),
 created_at TEXT NOT NULL,
 CHECK((decision='APPROVAL_REQUIRED') = (approval_id IS NOT NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE INDEX agent_action_requests_run ON agent_action_requests(organization_id,run_id,created_at);
CREATE TRIGGER agent_action_requests_no_update BEFORE UPDATE ON agent_action_requests
 BEGIN SELECT RAISE(ABORT,'ACTION_REQUESTS_APPEND_ONLY'); END;
CREATE TRIGGER agent_action_requests_no_delete BEFORE DELETE ON agent_action_requests
 BEGIN SELECT RAISE(ABORT,'ACTION_REQUESTS_APPEND_ONLY'); END;
`;
