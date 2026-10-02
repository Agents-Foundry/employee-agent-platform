/**
 * Organization-managed model credentials (ADR 0034).
 *
 * `organization_model_credentials` says which secret holds an organization's key for a model
 * provider: a `secret://` reference, never the key. The secret broker resolves it for the
 * runtime holding a running run whose signed manifest names that provider. One row per
 * organization and provider; an administrator can point it at another reference or disable
 * it, and rows are never removed.
 */
export const modelCredentialsSql = String.raw`
CREATE TABLE organization_model_credentials (
 organization_id text NOT NULL REFERENCES organizations(id),
 provider text NOT NULL CHECK(provider ~ '^[a-zA-Z0-9._-]{1,80}$'),
 secret_ref text NOT NULL CHECK(secret_ref ~ '^secret://[a-z0-9][a-z0-9._-]{0,63}$'),
 status text NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(organization_id,provider),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE TRIGGER organization_model_credentials_identity_immutable
 BEFORE UPDATE OF organization_id, provider, created_by, created_at ON organization_model_credentials
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_CREDENTIAL_IDENTITY_IMMUTABLE');
CREATE TRIGGER organization_model_credentials_no_delete BEFORE DELETE ON organization_model_credentials
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_CREDENTIAL_RETAINED');

ALTER TABLE organization_model_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_model_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_model_credentials
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON organization_model_credentials TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_model_credentials TO af_platform;
`;
