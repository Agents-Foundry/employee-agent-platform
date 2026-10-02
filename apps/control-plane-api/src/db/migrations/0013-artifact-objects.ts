/**
 * Durable artifact storage (ADR 0033).
 *
 * `agent_artifact_objects` records every artifact whose bytes the control plane holds in its
 * artifact store: tenant, run, thread, step and tool call, media type, size, SHA-256,
 * retention class, storage key and lifecycle. It never holds the bytes. The registration in
 * `agent_artifacts` stays immutable; this row carries what changes.
 *
 * A row moves only forward: PENDING (bytes being written) → STORED → REGISTERED (the run's
 * `artifact.created` event matched it) → DELETED, or straight to DELETED when it was never
 * registered. Everything but the lifecycle columns is immutable, and rows are never removed,
 * so the deletion of an artifact's bytes stays on record.
 */
export const artifactObjectsSql = String.raw`
CREATE TABLE agent_artifact_objects (
 artifact_id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 thread_id text NOT NULL,
 run_id text NOT NULL,
 step_id text NOT NULL,
 tool_call_id text,
 store text NOT NULL CHECK(store ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
 storage_key text NOT NULL UNIQUE
  CHECK(storage_key ~ '^[A-Za-z0-9._/-]+$' AND length(storage_key) <= 512),
 media_type text NOT NULL CHECK(length(media_type) BETWEEN 3 AND 129),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 retention_class text NOT NULL
  CHECK(retention_class IN ('EPHEMERAL','STANDARD_30D','EXTENDED_365D','LEGAL_HOLD')),
 state text NOT NULL CHECK(state IN ('PENDING','STORED','REGISTERED','DELETED')),
 uploaded_by text NOT NULL CHECK(length(uploaded_by) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL,
 registered_at timestamptz,
 expires_at timestamptz,
 deleted_at timestamptz,
 deletion_reason text CHECK(deletion_reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 CHECK((retention_class='LEGAL_HOLD') = (expires_at IS NULL)),
 CHECK(state<>'REGISTERED' OR registered_at IS NOT NULL),
 CHECK((state='DELETED') = (deleted_at IS NOT NULL)),
 CHECK((deleted_at IS NULL) = (deletion_reason IS NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE INDEX agent_artifact_objects_run ON agent_artifact_objects(organization_id,run_id);
CREATE INDEX agent_artifact_objects_due ON agent_artifact_objects(expires_at)
 WHERE state='REGISTERED';
CREATE INDEX agent_artifact_objects_unregistered ON agent_artifact_objects(created_at)
 WHERE state IN ('PENDING','STORED');
CREATE TRIGGER agent_artifact_objects_scope BEFORE INSERT ON agent_artifact_objects
 FOR EACH ROW EXECUTE FUNCTION run_scope_check('ARTIFACT_SCOPE_MISMATCH');
CREATE FUNCTION af_artifact_object_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.artifact_id, NEW.organization_id, NEW.thread_id, NEW.run_id, NEW.step_id,
      NEW.tool_call_id, NEW.store, NEW.storage_key, NEW.media_type, NEW.size_bytes, NEW.sha256,
      NEW.retention_class, NEW.uploaded_by, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.artifact_id, OLD.organization_id, OLD.thread_id, OLD.run_id, OLD.step_id,
      OLD.tool_call_id, OLD.store, OLD.storage_key, OLD.media_type, OLD.size_bytes, OLD.sha256,
      OLD.retention_class, OLD.uploaded_by, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'ARTIFACT_OBJECT_IMMUTABLE';
  END IF;
  IF NOT (
       (OLD.state='PENDING' AND NEW.state IN ('STORED','DELETED'))
    OR (OLD.state='STORED' AND NEW.state IN ('REGISTERED','DELETED'))
    OR (OLD.state='REGISTERED' AND NEW.state='DELETED')
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_OBJECT_TRANSITION_INVALID';
  END IF;
  IF OLD.registered_at IS NOT NULL AND NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
    RAISE EXCEPTION 'ARTIFACT_OBJECT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_artifact_objects_transition BEFORE UPDATE ON agent_artifact_objects
 FOR EACH ROW EXECUTE FUNCTION af_artifact_object_transition();
CREATE TRIGGER agent_artifact_objects_no_delete BEFORE DELETE ON agent_artifact_objects
 FOR EACH ROW EXECUTE FUNCTION af_reject('ARTIFACT_OBJECT_RETAINED');

ALTER TABLE agent_artifact_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_artifact_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_artifact_objects
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON agent_artifact_objects TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_artifact_objects TO af_platform;
`;
