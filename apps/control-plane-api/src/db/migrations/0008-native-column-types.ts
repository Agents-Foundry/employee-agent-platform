/**
 * Native column types (ADR 0028). Timestamps stored as ISO-8601 text become `timestamptz`, and
 * JSON the API only ever parses becomes `jsonb`. Text whose exact bytes are signed or pinned
 * by digest stays `text`: signed manifests, signed execution grants, webhook bodies and
 * registered catalog content. Message content is not JSON. Epoch-millisecond expiries are
 * already `bigint`.
 *
 * Each table is altered in one statement, so constraints that compare two of its columns are
 * checked once, against the new types. A value that is not a valid timestamp or JSON fails the
 * migration, which then changes nothing.
 */
const timestamps: Record<string, string[]> = {
  account_password_credentials: ['updated_at'],
  agent_action_executions: ['started_at', 'completed_at'],
  agent_action_requests: ['created_at'],
  agent_artifacts: ['created_at'],
  agent_assignments: ['created_at'],
  agent_events: ['occurred_at', 'recorded_at'],
  agent_execution_grants: ['issued_at', 'expires_at'],
  agent_run_leases: ['claimed_at', 'heartbeat_at', 'lease_expires_at', 'closed_at'],
  agent_run_steps: ['created_at', 'started_at', 'completed_at'],
  agent_runs: ['created_at', 'updated_at', 'started_at', 'completed_at'],
  agent_threads: ['created_at', 'updated_at'],
  alert_webhook_deliveries: ['next_attempt_at', 'last_attempt_at', 'delivered_at', 'created_at'],
  approvals: ['decided_at', 'created_at', 'expires_at'],
  audit_events: ['created_at'],
  catalog_blueprint_versions: ['registered_at'],
  conversations: ['created_at', 'updated_at'],
  employee_position_assignments: ['started_at', 'ended_at'],
  job_disciplines: ['created_at', 'updated_at'],
  job_families: ['created_at', 'updated_at'],
  job_levels: ['created_at', 'updated_at'],
  llm_key_bindings: ['created_at'],
  messages: ['created_at'],
  model_budget_alerts: ['created_at', 'acknowledged_at'],
  model_prices: ['set_at'],
  model_quality_results: ['run_at', 'imported_at'],
  model_usage_reservations: ['created_at', 'settled_at'],
  organization_action_policies: ['updated_at'],
  organization_agent_installations: ['created_at', 'updated_at'],
  organization_alert_webhooks: ['created_at', 'updated_at'],
  organization_change_events: ['created_at'],
  organization_connector_connections: ['created_at', 'updated_at'],
  organization_domains: ['verified_at', 'created_at', 'updated_at'],
  organization_memberships: ['joined_at', 'updated_at'],
  organization_model_budgets: ['updated_at'],
  organizational_unit_memberships: ['created_at', 'started_at', 'ended_at'],
  organizational_units: ['created_at', 'updated_at'],
  organizations: ['created_at', 'updated_at'],
  positions: ['created_at', 'updated_at'],
  qa_runs: ['created_at'],
  roles: ['created_at', 'updated_at'],
  users: ['created_at'],
};

const json: Record<string, string[]> = {
  admin_agent_batches: ['result'],
  agent_action_executions: ['result'],
  agent_action_requests: ['parameters', 'change_set'],
  agent_events: ['payload'],
  agent_run_steps: ['detail'],
  agent_runs: ['task'],
  audit_events: ['metadata'],
  login_transactions: ['body'],
  model_quality_results: ['failed_gates'],
  organization_agent_installations: ['configuration'],
  organization_change_events: ['before_json', 'after_json'],
  organization_connector_connections: ['settings'],
  provisioning_requests: ['body'],
};

const alterations = [...new Set([...Object.keys(timestamps), ...Object.keys(json)])]
  .sort()
  .map((table) => {
    const changes = [
      ...(timestamps[table] ?? []).map(
        (column) => `ALTER COLUMN ${column} TYPE timestamptz USING ${column}::timestamptz`,
      ),
      ...(json[table] ?? []).map(
        (column) => `ALTER COLUMN ${column} TYPE jsonb USING ${column}::jsonb`,
      ),
    ];
    return `ALTER TABLE ${table}\n ${changes.join(',\n ')};`;
  })
  .join('\n');

const jsonColumns = Object.entries(json)
  .flatMap(([table, columns]) => columns.map((column) => `('${table}','${column}')`))
  .join(',');

export const nativeColumnTypesSql = String.raw`
-- A stored time without an offset is UTC, whatever the server's time zone.
SET LOCAL TimeZone = 'UTC';

-- JSON validity is now the column type; the text checks cannot apply to jsonb.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT t.relname AS table_name, k.conname
    FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
    WHERE k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%af_json_valid(%'
      AND (t.relname, substring(pg_get_constraintdef(k.oid) FROM 'af_json_valid\((\w+)\)'))
        IN (VALUES ${jsonColumns})
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', item.table_name, item.conname);
  END LOOP;
END $$;
ALTER TABLE agent_run_steps ALTER COLUMN detail DROP DEFAULT;

-- Triggers that name a converted column are recreated unchanged afterwards.
DROP TRIGGER installation_identity_immutable ON organization_agent_installations;
DROP TRIGGER agent_runs_identity_immutable ON agent_runs;
DROP TRIGGER agent_run_steps_identity_immutable ON agent_run_steps;
DROP TRIGGER agent_run_leases_identity_immutable ON agent_run_leases;
DROP TRIGGER connector_connections_identity_immutable ON organization_connector_connections;

${alterations}

ALTER TABLE agent_run_steps ALTER COLUMN detail SET DEFAULT '{}'::jsonb;

CREATE TRIGGER installation_identity_immutable BEFORE UPDATE OF id,organization_id,blueprint_id,created_by,created_at
 ON organization_agent_installations FOR EACH ROW EXECUTE FUNCTION af_reject('INSTALLATION_IDENTITY_IMMUTABLE');
CREATE TRIGGER agent_runs_identity_immutable BEFORE UPDATE OF
 id,organization_id,thread_id,employee_id,agent_id,manifest_id,manifest_api_version,manifest_key_id,task,legacy_qa_run_id,created_at
 ON agent_runs FOR EACH ROW EXECUTE FUNCTION af_reject('RUN_IDENTITY_IMMUTABLE');
CREATE TRIGGER agent_run_steps_identity_immutable BEFORE UPDATE OF id,organization_id,run_id,sequence,kind,created_at
 ON agent_run_steps FOR EACH ROW EXECUTE FUNCTION af_reject('STEP_IDENTITY_IMMUTABLE');
CREATE TRIGGER agent_run_leases_identity_immutable BEFORE UPDATE OF run_id,organization_id,claimed_at
 ON agent_run_leases FOR EACH ROW EXECUTE FUNCTION af_reject('LEASE_IDENTITY_IMMUTABLE');
CREATE TRIGGER connector_connections_identity_immutable BEFORE UPDATE OF id,organization_id,provider,created_by,created_at
 ON organization_connector_connections FOR EACH ROW EXECUTE FUNCTION af_reject('CONNECTION_IDENTITY_IMMUTABLE');

-- Milliseconds, like every timestamp the API writes, so values read back compare equal.
CREATE OR REPLACE FUNCTION organization_profile_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.code := coalesce(NEW.code, upper(NEW.slug));
  NEW.created_at := coalesce(NEW.created_at, date_trunc('milliseconds', clock_timestamp()));
  NEW.updated_at := coalesce(NEW.updated_at, date_trunc('milliseconds', clock_timestamp()));
  RETURN NEW;
END $$;
`;
