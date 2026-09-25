/**
 * Action Gateway (Architecture V2 Phase D, ADR 0012). Additive: legacy approvals keep a NULL
 * expiry and never expire; earlier action requests keep NULL parameters and policy fields.
 */
export const actionGatewaySql = `
ALTER TABLE approvals ADD COLUMN expires_at TEXT;
CREATE INDEX approvals_expiry ON approvals(status,expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE agent_action_requests ADD COLUMN parameters TEXT CHECK(parameters IS NULL OR json_valid(parameters));
ALTER TABLE agent_action_requests ADD COLUMN policy_id TEXT;
ALTER TABLE agent_action_requests ADD COLUMN policy_version TEXT;

CREATE TABLE organization_connector_connections (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 provider TEXT NOT NULL CHECK(provider IN ('jira')),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 base_url TEXT NOT NULL CHECK(base_url LIKE 'http%'),
 secret_ref TEXT NOT NULL CHECK(secret_ref LIKE 'secret://%'),
 settings TEXT NOT NULL CHECK(json_valid(settings)),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
-- One active connection per provider keeps connector selection deterministic.
CREATE UNIQUE INDEX connector_one_active_per_provider ON organization_connector_connections(organization_id,provider)
 WHERE status='ACTIVE';
CREATE TRIGGER connector_connections_identity_immutable BEFORE UPDATE OF id,organization_id,provider,created_by,created_at
 ON organization_connector_connections BEGIN SELECT RAISE(ABORT,'CONNECTION_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER connector_connections_no_delete BEFORE DELETE ON organization_connector_connections
 BEGIN SELECT RAISE(ABORT,'CONNECTION_HISTORY_RETAINED'); END;

CREATE TABLE organization_action_policies (
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 action TEXT NOT NULL CHECK(length(action) BETWEEN 3 AND 120),
 outcome TEXT NOT NULL CHECK(outcome IN ('REQUIRE_APPROVAL','DENY')),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(organization_id,action),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);

CREATE TABLE agent_action_executions (
 request_id TEXT PRIMARY KEY REFERENCES agent_action_requests(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 run_id TEXT NOT NULL,
 connection_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('DISPATCHING','SUCCEEDED','FAILED')),
 result TEXT CHECK(result IS NULL OR json_valid(result)),
 error_code TEXT,
 started_at TEXT NOT NULL,
 completed_at TEXT,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES organization_connector_connections(organization_id,id)
);
-- Single use: an execution is inserted once and only moves from DISPATCHING to a final state.
CREATE TRIGGER agent_action_executions_transition BEFORE UPDATE ON agent_action_executions BEGIN
 SELECT RAISE(ABORT,'ACTION_EXECUTION_FINAL') WHERE OLD.status<>'DISPATCHING'
  OR NEW.status NOT IN ('SUCCEEDED','FAILED') OR NEW.request_id<>OLD.request_id
  OR NEW.organization_id<>OLD.organization_id OR NEW.run_id<>OLD.run_id
  OR NEW.connection_id IS NOT OLD.connection_id OR NEW.started_at<>OLD.started_at;
END;
CREATE TRIGGER agent_action_executions_no_delete BEFORE DELETE ON agent_action_executions
 BEGIN SELECT RAISE(ABORT,'ACTION_REQUESTS_APPEND_ONLY'); END;
`;
