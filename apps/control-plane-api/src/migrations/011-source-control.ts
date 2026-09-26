/**
 * Source control (Architecture V2 Phase G, ADR 0015). Additive in effect:
 * - connections may use the `github` provider. SQLite cannot alter a CHECK constraint, so the
 *   table is rebuilt with identical columns, rows, index and triggers (foreign keys are checked
 *   before commit);
 * - an action request can keep the workspace change set it was decided on, so a pull request
 *   publishes exactly the files that were approved.
 */
export const sourceControlSql = `
CREATE TABLE organization_connector_connections_v11 (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 provider TEXT NOT NULL CHECK(provider IN ('jira','github')),
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
INSERT INTO organization_connector_connections_v11
 (id,organization_id,provider,name,base_url,secret_ref,settings,status,version,created_by,created_at,updated_by,updated_at)
 SELECT id,organization_id,provider,name,base_url,secret_ref,settings,status,version,created_by,created_at,updated_by,updated_at
 FROM organization_connector_connections;
DROP TABLE organization_connector_connections;
ALTER TABLE organization_connector_connections_v11 RENAME TO organization_connector_connections;
CREATE UNIQUE INDEX connector_one_active_per_provider ON organization_connector_connections(organization_id,provider)
 WHERE status='ACTIVE';
CREATE TRIGGER connector_connections_identity_immutable BEFORE UPDATE OF id,organization_id,provider,created_by,created_at
 ON organization_connector_connections BEGIN SELECT RAISE(ABORT,'CONNECTION_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER connector_connections_no_delete BEFORE DELETE ON organization_connector_connections
 BEGIN SELECT RAISE(ABORT,'CONNECTION_HISTORY_RETAINED'); END;

ALTER TABLE agent_action_requests ADD COLUMN change_set TEXT
 CHECK(change_set IS NULL OR json_valid(change_set));
`;
