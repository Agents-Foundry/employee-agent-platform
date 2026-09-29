/**
 * Per-model prices and cost limits (ADR 0022). An organization's price book is append-only:
 * each change adds a row that supersedes the model's previous one, and a row without prices
 * removes the model's price. Every model call records the price it was reserved under, so a
 * later price change never rewrites what an earlier call cost. Money is in integer millionths
 * of the organization's currency ("micros").
 */
export const modelPricesSql = String.raw`
ALTER TABLE organization_model_budgets
 ADD COLUMN currency text NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'),
 ADD COLUMN monthly_cost_limit_micros bigint
   CHECK(monthly_cost_limit_micros IS NULL OR monthly_cost_limit_micros>0),
 ADD COLUMN run_cost_limit_micros bigint
   CHECK(run_cost_limit_micros IS NULL OR run_cost_limit_micros>0);

CREATE TABLE model_prices (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 provider text NOT NULL,
 model text NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 input_micros_per_million bigint CHECK(input_micros_per_million BETWEEN 0 AND 10000000000),
 output_micros_per_million bigint CHECK(output_micros_per_million BETWEEN 0 AND 10000000000),
 supersedes text,
 set_by text NOT NULL,
 set_at text NOT NULL,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 CHECK((input_micros_per_million IS NULL) = (output_micros_per_million IS NULL)),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,supersedes),
 FOREIGN KEY(organization_id,supersedes) REFERENCES model_prices(organization_id,id),
 FOREIGN KEY(organization_id,set_by) REFERENCES employees(organization_id,id)
);
CREATE INDEX model_prices_model ON model_prices(organization_id,provider,model,seq);
-- One chain per model: only its first price supersedes nothing.
CREATE UNIQUE INDEX model_prices_first ON model_prices(organization_id,provider,model)
 WHERE supersedes IS NULL;
CREATE TRIGGER model_prices_no_update BEFORE UPDATE ON model_prices
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_PRICE_IMMUTABLE');
CREATE TRIGGER model_prices_no_delete BEFORE DELETE ON model_prices
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_PRICE_IMMUTABLE');

ALTER TABLE model_usage_reservations
 ADD COLUMN price_id text,
 ADD COLUMN currency text,
 ADD COLUMN reserved_cost_micros bigint CHECK(reserved_cost_micros>=0),
 ADD COLUMN cost_micros bigint CHECK(cost_micros>=0),
 ADD CONSTRAINT model_usage_price FOREIGN KEY(organization_id,price_id)
   REFERENCES model_prices(organization_id,id),
 ADD CONSTRAINT model_usage_priced CHECK(
   (price_id IS NULL) = (currency IS NULL) AND (price_id IS NULL) = (reserved_cost_micros IS NULL)
   AND (cost_micros IS NULL) = (price_id IS NULL OR status='RESERVED'));

-- The settlement is still the only change, now including its cost.
CREATE OR REPLACE FUNCTION af_model_usage_settle_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'RESERVED' OR NEW.status <> 'SETTLED'
     OR (NEW.id, NEW.organization_id, NEW.run_id, NEW.employee_id, NEW.agent_id, NEW.runtime_id,
         NEW.provider, NEW.model, NEW.period, NEW.reserved_tokens, NEW.max_output_tokens,
         NEW.request_hash, NEW.created_at, NEW.price_id, NEW.currency, NEW.reserved_cost_micros)
     IS DISTINCT FROM
        (OLD.id, OLD.organization_id, OLD.run_id, OLD.employee_id, OLD.agent_id, OLD.runtime_id,
         OLD.provider, OLD.model, OLD.period, OLD.reserved_tokens, OLD.max_output_tokens,
         OLD.request_hash, OLD.created_at, OLD.price_id, OLD.currency, OLD.reserved_cost_micros) THEN
    RAISE EXCEPTION 'MODEL_USAGE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_prices
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT ON model_prices TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON model_prices TO af_platform;
`;
