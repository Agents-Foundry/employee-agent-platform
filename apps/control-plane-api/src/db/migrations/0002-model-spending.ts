/**
 * Organization model spending limits (ADR 0021). An organization's token limits, and one row
 * per model call: reserved before the call, settled with the provider's reported usage after.
 * An unsettled reservation keeps counting at its reserved size, so a lost settlement can only
 * make the organization's remaining budget smaller, never larger.
 */
export const modelSpendingSql = String.raw`
CREATE TABLE organization_model_budgets (
 organization_id text PRIMARY KEY REFERENCES organizations(id),
 monthly_token_limit bigint CHECK(monthly_token_limit IS NULL OR monthly_token_limit>0),
 run_token_limit bigint CHECK(run_token_limit IS NULL OR run_token_limit>0),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by text NOT NULL,
 updated_at text NOT NULL,
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);

CREATE TABLE model_usage_reservations (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 run_id text NOT NULL,
 employee_id text NOT NULL,
 agent_id text NOT NULL,
 runtime_id text NOT NULL,
 provider text NOT NULL,
 model text NOT NULL,
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-[0-9]{2}$'),
 reserved_tokens bigint NOT NULL CHECK(reserved_tokens>0),
 max_output_tokens bigint NOT NULL CHECK(max_output_tokens>0),
 status text NOT NULL CHECK(status IN ('RESERVED','SETTLED')),
 input_tokens bigint CHECK(input_tokens>=0),
 output_tokens bigint CHECK(output_tokens>=0),
 request_hash text NOT NULL,
 created_at text NOT NULL,
 settled_at text,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 CHECK((status='SETTLED') = (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND settled_at IS NOT NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id)
);
CREATE INDEX model_usage_period ON model_usage_reservations(organization_id,period);
CREATE INDEX model_usage_run ON model_usage_reservations(organization_id,run_id);
-- Only a reservation's settlement may change it, once; usage history is never deleted.
CREATE FUNCTION af_model_usage_settle_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'RESERVED' OR NEW.status <> 'SETTLED'
     OR (NEW.id, NEW.organization_id, NEW.run_id, NEW.employee_id, NEW.agent_id, NEW.runtime_id,
         NEW.provider, NEW.model, NEW.period, NEW.reserved_tokens, NEW.max_output_tokens,
         NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.run_id, OLD.employee_id, OLD.agent_id, OLD.runtime_id,
         OLD.provider, OLD.model, OLD.period, OLD.reserved_tokens, OLD.max_output_tokens,
         OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'MODEL_USAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_usage_settle_only BEFORE UPDATE ON model_usage_reservations
 FOR EACH ROW EXECUTE FUNCTION af_model_usage_settle_only();
CREATE TRIGGER model_usage_no_delete BEFORE DELETE ON model_usage_reservations
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_USAGE_IMMUTABLE');

ALTER TABLE organization_model_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_model_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_model_budgets
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());
ALTER TABLE model_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_usage_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_usage_reservations
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON organization_model_budgets, model_usage_reservations TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_model_budgets, model_usage_reservations
 TO af_platform;
`;
