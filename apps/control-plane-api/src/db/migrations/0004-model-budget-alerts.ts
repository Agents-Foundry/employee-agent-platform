/**
 * Model budget alerts (ADR 0023). An organization chooses the percentages of its monthly token
 * and cost limits at which administrators are alerted. Each alert is raised once per month,
 * limit and threshold; 100 means the limit is reached. Alerts are history: only their
 * acknowledgement may change them, once, and they are never deleted.
 */
export const modelBudgetAlertsSql = String.raw`
ALTER TABLE organization_model_budgets
 ADD COLUMN alert_thresholds smallint[] NOT NULL DEFAULT '{80}'
   CHECK(cardinality(alert_thresholds) <= 5 AND array_position(alert_thresholds, NULL) IS NULL
     AND 1 <= ALL(alert_thresholds) AND 99 >= ALL(alert_thresholds));

CREATE TABLE model_budget_alerts (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-[0-9]{2}$'),
 scope text NOT NULL CHECK(scope IN ('MONTHLY_TOKENS','MONTHLY_COST')),
 threshold_percent smallint NOT NULL CHECK(threshold_percent BETWEEN 1 AND 100),
 limit_value bigint NOT NULL CHECK(limit_value>0),
 charged_value bigint NOT NULL CHECK(charged_value>=0),
 currency text CHECK(currency ~ '^[A-Z]{3}$'),
 created_at text NOT NULL,
 acknowledged_by text,
 acknowledged_at text,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 UNIQUE(organization_id,period,scope,threshold_percent),
 CHECK((scope='MONTHLY_COST') = (currency IS NOT NULL)),
 CHECK((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
 FOREIGN KEY(organization_id,acknowledged_by) REFERENCES employees(organization_id,id)
);
CREATE INDEX model_budget_alerts_period ON model_budget_alerts(organization_id,period);
CREATE FUNCTION af_model_budget_alert_ack_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.acknowledged_at IS NOT NULL OR NEW.acknowledged_at IS NULL
     OR (NEW.id, NEW.organization_id, NEW.period, NEW.scope, NEW.threshold_percent,
         NEW.limit_value, NEW.charged_value, NEW.currency, NEW.created_at)
     IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.period, OLD.scope, OLD.threshold_percent,
         OLD.limit_value, OLD.charged_value, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'MODEL_BUDGET_ALERT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_budget_alerts_ack_only BEFORE UPDATE ON model_budget_alerts
 FOR EACH ROW EXECUTE FUNCTION af_model_budget_alert_ack_only();
CREATE TRIGGER model_budget_alerts_no_delete BEFORE DELETE ON model_budget_alerts
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_BUDGET_ALERT_IMMUTABLE');

ALTER TABLE model_budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_budget_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_budget_alerts
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON model_budget_alerts TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON model_budget_alerts TO af_platform;
`;
