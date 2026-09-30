/**
 * Alert webhooks (ADR 0024). An organization's endpoints, and an outbox of deliveries: each
 * row is queued in the transaction that raises its alert, and a dispatcher sends it later.
 * An endpoint's URL never changes once set; only its status does. A delivery's identity and
 * body never change; its attempts are recorded until it is delivered or fails for good.
 */
export const alertWebhooksSql = String.raw`
CREATE TABLE organization_alert_webhooks (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 url text NOT NULL CHECK(url ~ '^https?://' AND length(url) <= 500),
 description text NOT NULL CHECK(length(description) <= 200),
 status text NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL,
 created_at text NOT NULL,
 updated_by text NOT NULL,
 updated_at text NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE FUNCTION af_alert_webhook_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.url, NEW.description, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.url, OLD.description, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'ALERT_WEBHOOK_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_webhooks_status_only BEFORE UPDATE ON organization_alert_webhooks
 FOR EACH ROW EXECUTE FUNCTION af_alert_webhook_status_only();
CREATE TRIGGER alert_webhooks_no_delete BEFORE DELETE ON organization_alert_webhooks
 FOR EACH ROW EXECUTE FUNCTION af_reject('ALERT_WEBHOOK_IMMUTABLE');

CREATE TABLE alert_webhook_deliveries (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 webhook_id text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('model.budget.alert','webhook.test')),
 alert_id text REFERENCES model_budget_alerts(id),
 body text NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','DELIVERED','FAILED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
 next_attempt_at text,
 last_attempt_at text,
 last_status_code integer CHECK(last_status_code BETWEEN 100 AND 599),
 last_error text CHECK(length(last_error) <= 80),
 delivered_at text,
 created_at text NOT NULL,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 UNIQUE(webhook_id,alert_id),
 CHECK((event_type='model.budget.alert') = (alert_id IS NOT NULL)),
 CHECK((status='PENDING') = (next_attempt_at IS NOT NULL)),
 CHECK((status='DELIVERED') = (delivered_at IS NOT NULL)),
 FOREIGN KEY(organization_id,webhook_id) REFERENCES organization_alert_webhooks(organization_id,id)
);
CREATE INDEX alert_webhook_deliveries_due ON alert_webhook_deliveries(next_attempt_at)
 WHERE status='PENDING';
CREATE INDEX alert_webhook_deliveries_recent ON alert_webhook_deliveries(organization_id,seq);
CREATE FUNCTION af_alert_webhook_delivery_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING'
     OR NEW.attempts < OLD.attempts
     OR (NEW.id, NEW.organization_id, NEW.webhook_id, NEW.event_type, NEW.alert_id, NEW.body, NEW.created_at)
     IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.webhook_id, OLD.event_type, OLD.alert_id, OLD.body, OLD.created_at) THEN
    RAISE EXCEPTION 'ALERT_WEBHOOK_DELIVERY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_webhook_deliveries_progress BEFORE UPDATE ON alert_webhook_deliveries
 FOR EACH ROW EXECUTE FUNCTION af_alert_webhook_delivery_progress();
CREATE TRIGGER alert_webhook_deliveries_no_delete BEFORE DELETE ON alert_webhook_deliveries
 FOR EACH ROW EXECUTE FUNCTION af_reject('ALERT_WEBHOOK_DELIVERY_IMMUTABLE');

ALTER TABLE organization_alert_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_alert_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_alert_webhooks
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());
ALTER TABLE alert_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON alert_webhook_deliveries
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON organization_alert_webhooks TO af_tenant;
GRANT SELECT, INSERT ON alert_webhook_deliveries TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_alert_webhooks, alert_webhook_deliveries
 TO af_platform;
`;
