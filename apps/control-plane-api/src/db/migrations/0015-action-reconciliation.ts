/**
 * Manual reconciliation of governed writes whose outcome is unknown (ADR 0036).
 *
 * When a connector does not confirm a write (a timeout, a dropped connection, a server error
 * after the request was sent), or the control plane stopped while it was dispatching one, the
 * external system may or may not have applied it. `agent_action_reconciliations` records that
 * the execution needs a person to check. While a row is `REQUIRED`, the same action is not
 * dispatched again for that thread, or with that payload anywhere in the organization.
 *
 * A row is written once and resolved once, by an administrator: `APPLIED` (the external system
 * has it) or `NOT_APPLIED` (it does not; the action may be requested again). Rows are never
 * removed.
 */
export const actionReconciliationSql = String.raw`
CREATE TABLE agent_action_reconciliations (
 request_id text PRIMARY KEY REFERENCES agent_action_executions(request_id),
 organization_id text NOT NULL REFERENCES organizations(id),
 thread_id text NOT NULL,
 run_id text NOT NULL,
 action text NOT NULL CHECK(action ~ '^[a-z][a-z0-9_.]+$' AND length(action) <= 120),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(reason IN ('CONNECTOR_OUTCOME_UNKNOWN','DISPATCH_INTERRUPTED')),
 state text NOT NULL CHECK(state IN ('REQUIRED','APPLIED','NOT_APPLIED')),
 created_at timestamptz NOT NULL,
 resolved_by text,
 resolved_at timestamptz,
 note text CHECK(note IS NULL OR length(note) <= 500),
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 CHECK((state='REQUIRED') = (resolved_at IS NULL)),
 CHECK((resolved_at IS NULL) = (resolved_by IS NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,resolved_by) REFERENCES employees(organization_id,id)
);
CREATE INDEX agent_action_reconciliations_payload
 ON agent_action_reconciliations(organization_id,action,payload_digest) WHERE state='REQUIRED';
CREATE INDEX agent_action_reconciliations_thread
 ON agent_action_reconciliations(organization_id,thread_id,action) WHERE state='REQUIRED';
CREATE FUNCTION af_action_reconciliation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state<>'REQUIRED' OR NEW.state NOT IN ('APPLIED','NOT_APPLIED')
     OR (NEW.request_id, NEW.organization_id, NEW.thread_id, NEW.run_id, NEW.action,
         NEW.payload_digest, NEW.reason, NEW.created_at)
        IS DISTINCT FROM
        (OLD.request_id, OLD.organization_id, OLD.thread_id, OLD.run_id, OLD.action,
         OLD.payload_digest, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'ACTION_RECONCILIATION_FINAL';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_action_reconciliations_transition BEFORE UPDATE ON agent_action_reconciliations
 FOR EACH ROW EXECUTE FUNCTION af_action_reconciliation_transition();
CREATE TRIGGER agent_action_reconciliations_no_delete BEFORE DELETE ON agent_action_reconciliations
 FOR EACH ROW EXECUTE FUNCTION af_reject('ACTION_RECONCILIATION_RETAINED');

ALTER TABLE agent_action_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_action_reconciliations
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON agent_action_reconciliations TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_action_reconciliations TO af_platform;
`;
