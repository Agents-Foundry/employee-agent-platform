/**
 * Generic execution records (ADR 0003, ADR 0008). Additive: existing conversations, agents,
 * approvals and QA runs keep their rows and IDs. Events and artifacts are append-only.
 */
export const agentExecutionSql = `
CREATE UNIQUE INDEX conversations_tenant_id ON conversations(organization_id,id);
CREATE UNIQUE INDEX agents_tenant_id ON agents(organization_id,id);

CREATE TABLE agent_threads (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 employee_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 conversation_id TEXT,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES conversations(organization_id,id)
);
CREATE INDEX agent_threads_conversation ON agent_threads(organization_id,conversation_id,agent_id,status);

CREATE TABLE agent_runs (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 thread_id TEXT NOT NULL,
 employee_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 manifest_id TEXT,
 manifest_api_version TEXT CHECK(manifest_api_version IN ('agents-foundry/v1','agents-foundry/v2')),
 manifest_key_id TEXT,
 task TEXT NOT NULL CHECK(json_valid(task)),
 runtime_profile TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL','COMPLETED','FAILED','CANCELLED')),
 status_reason TEXT,
 legacy_qa_run_id TEXT UNIQUE REFERENCES qa_runs(id),
 runtime_sequence INTEGER NOT NULL DEFAULT 0 CHECK(runtime_sequence>=0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 started_at TEXT,
 completed_at TEXT,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id),
 CHECK((manifest_id IS NULL) = (manifest_api_version IS NULL) AND (manifest_id IS NULL) = (manifest_key_id IS NULL))
);
-- One active run per thread: a shared workspace is never mutated concurrently.
CREATE UNIQUE INDEX one_active_run_per_thread ON agent_runs(organization_id,thread_id)
 WHERE status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL');
CREATE INDEX agent_runs_employee ON agent_runs(organization_id,employee_id,created_at);
CREATE TRIGGER agent_runs_thread_owner BEFORE INSERT ON agent_runs BEGIN
 SELECT RAISE(ABORT,'RUN_THREAD_MISMATCH') WHERE NOT EXISTS (
  SELECT 1 FROM agent_threads WHERE id=NEW.thread_id AND organization_id=NEW.organization_id
   AND employee_id=NEW.employee_id AND agent_id=NEW.agent_id AND status='ACTIVE');
END;
CREATE TRIGGER agent_runs_identity_immutable BEFORE UPDATE OF
 id,organization_id,thread_id,employee_id,agent_id,manifest_id,manifest_api_version,manifest_key_id,task,legacy_qa_run_id,created_at
 ON agent_runs BEGIN SELECT RAISE(ABORT,'RUN_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER agent_runs_terminal_immutable BEFORE UPDATE ON agent_runs
 WHEN OLD.status IN ('COMPLETED','FAILED','CANCELLED') BEGIN SELECT RAISE(ABORT,'RUN_TERMINAL'); END;
CREATE TRIGGER agent_runs_no_delete BEFORE DELETE ON agent_runs BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_RETAINED'); END;

CREATE TABLE agent_run_steps (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 run_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 kind TEXT NOT NULL CHECK(kind IN ('PLAN','MODEL','TOOL','ACTION','MESSAGE')),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','WAITING_FOR_APPROVAL','COMPLETED','FAILED','SKIPPED','CANCELLED')),
 detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail)),
 created_at TEXT NOT NULL,
 started_at TEXT,
 completed_at TEXT,
 UNIQUE(organization_id,id),
 UNIQUE(run_id,sequence),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE TRIGGER agent_run_steps_identity_immutable BEFORE UPDATE OF id,organization_id,run_id,sequence,kind,created_at
 ON agent_run_steps BEGIN SELECT RAISE(ABORT,'STEP_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER agent_run_steps_no_delete BEFORE DELETE ON agent_run_steps BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_RETAINED'); END;

CREATE TABLE agent_events (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 thread_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 step_id TEXT,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 runtime_sequence INTEGER CHECK(runtime_sequence>0),
 event_type TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('CONTROL_PLANE','RUNTIME')),
 actor_id TEXT,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 occurred_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 UNIQUE(run_id,sequence),
 UNIQUE(run_id,runtime_sequence),
 CHECK((source='RUNTIME') = (runtime_sequence IS NOT NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE TRIGGER agent_events_scope BEFORE INSERT ON agent_events BEGIN
 SELECT RAISE(ABORT,'EVENT_SCOPE_MISMATCH') WHERE NOT EXISTS (
  SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND thread_id=NEW.thread_id AND organization_id=NEW.organization_id)
  OR (NEW.step_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_run_steps WHERE id=NEW.step_id AND run_id=NEW.run_id));
END;
CREATE TRIGGER agent_events_no_update BEFORE UPDATE ON agent_events BEGIN SELECT RAISE(ABORT,'AGENT_EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER agent_events_no_delete BEFORE DELETE ON agent_events BEGIN SELECT RAISE(ABORT,'AGENT_EVENTS_APPEND_ONLY'); END;

CREATE TABLE agent_artifacts (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 thread_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 step_id TEXT,
 artifact_type TEXT NOT NULL,
 media_type TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
 storage_reference TEXT NOT NULL UNIQUE CHECK(storage_reference LIKE 'artifact://%'),
 checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256)=64),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 retention_policy TEXT NOT NULL CHECK(retention_policy IN ('EPHEMERAL','STANDARD_30D','EXTENDED_365D','LEGAL_HOLD')),
 created_at TEXT NOT NULL,
 created_by TEXT NOT NULL,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE INDEX agent_artifacts_run ON agent_artifacts(organization_id,run_id,created_at);
CREATE TRIGGER agent_artifacts_scope BEFORE INSERT ON agent_artifacts BEGIN
 SELECT RAISE(ABORT,'ARTIFACT_SCOPE_MISMATCH') WHERE NOT EXISTS (
  SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND thread_id=NEW.thread_id AND organization_id=NEW.organization_id)
  OR (NEW.step_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_run_steps WHERE id=NEW.step_id AND run_id=NEW.run_id));
END;
CREATE TRIGGER agent_artifacts_no_update BEFORE UPDATE ON agent_artifacts BEGIN SELECT RAISE(ABORT,'ARTIFACTS_IMMUTABLE'); END;
CREATE TRIGGER agent_artifacts_no_delete BEFORE DELETE ON agent_artifacts BEGIN SELECT RAISE(ABORT,'ARTIFACTS_IMMUTABLE'); END;

ALTER TABLE approvals ADD COLUMN run_id TEXT;
ALTER TABLE approvals ADD COLUMN step_id TEXT;
CREATE INDEX approvals_run ON approvals(organization_id,run_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER approvals_run_link BEFORE UPDATE OF run_id,step_id ON approvals BEGIN
 SELECT RAISE(ABORT,'APPROVAL_RUN_LINK_IMMUTABLE') WHERE OLD.run_id IS NOT NULL OR OLD.step_id IS NOT NULL;
 SELECT RAISE(ABORT,'APPROVAL_RUN_SCOPE_MISMATCH') WHERE NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND organization_id=NEW.organization_id);
 SELECT RAISE(ABORT,'APPROVAL_RUN_SCOPE_MISMATCH') WHERE NEW.step_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_run_steps WHERE id=NEW.step_id AND run_id=NEW.run_id AND organization_id=NEW.organization_id);
END;
CREATE TRIGGER approvals_run_link_insert BEFORE INSERT ON approvals WHEN NEW.run_id IS NOT NULL OR NEW.step_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'APPROVAL_RUN_SCOPE_MISMATCH') WHERE NEW.run_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND organization_id=NEW.organization_id)
  OR (NEW.step_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_run_steps WHERE id=NEW.step_id AND run_id=NEW.run_id AND organization_id=NEW.organization_id));
END;
`;
