/**
 * Durable run recovery (ADR 0032).
 *
 * `agent_run_checkpoints` holds the checkpoints agent runtimes save through the signed
 * transport, so a different runtime can continue a run. A checkpoint is bound to its tenant,
 * run, thread, lease session, manifest, workflow, step and approval. Rows are immutable, and
 * a version is accepted only if it is exactly one more than the stored one, so two runtimes
 * cannot both advance a run. The body holds conversation content: no route returns it to a
 * browser, and it is deleted when the run ends.
 *
 * `agent_run_leases.recoveries` counts how often a running run was handed to another runtime.
 */
export const runRecoverySql = String.raw`
ALTER TABLE agent_run_leases ADD COLUMN recoveries integer NOT NULL DEFAULT 0 CHECK(recoveries>=0);
CREATE INDEX agent_run_leases_expiry ON agent_run_leases(lease_expires_at) WHERE state='ACTIVE';

CREATE TABLE agent_run_checkpoints (
 organization_id text NOT NULL REFERENCES organizations(id),
 run_id text NOT NULL,
 version integer NOT NULL CHECK(version>0),
 thread_id text NOT NULL,
 session_id text NOT NULL,
 runtime_id text NOT NULL CHECK(length(runtime_id) BETWEEN 1 AND 120),
 manifest_id text NOT NULL,
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
 workflow text,
 step_id text,
 approval_id text,
 kernel_id text NOT NULL CHECK(length(kernel_id) BETWEEN 1 AND 100),
 runtime_sequence bigint NOT NULL CHECK(runtime_sequence>=0),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 body_bytes integer NOT NULL CHECK(body_bytes BETWEEN 2 AND 8388608),
 body text NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(run_id,version),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE FUNCTION af_checkpoint_next_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> COALESCE(
       (SELECT max(version) FROM agent_run_checkpoints WHERE run_id=NEW.run_id), 0) + 1 THEN
    RAISE EXCEPTION 'CHECKPOINT_VERSION_CONFLICT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_run_checkpoints_next_version BEFORE INSERT ON agent_run_checkpoints
 FOR EACH ROW EXECUTE FUNCTION af_checkpoint_next_version();
CREATE TRIGGER agent_run_checkpoints_no_update BEFORE UPDATE ON agent_run_checkpoints
 FOR EACH ROW EXECUTE FUNCTION af_reject('CHECKPOINT_IMMUTABLE');

ALTER TABLE agent_run_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_run_checkpoints
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, DELETE ON agent_run_checkpoints TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_run_checkpoints TO af_platform;
`;
