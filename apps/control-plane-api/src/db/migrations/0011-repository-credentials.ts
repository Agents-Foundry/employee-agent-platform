/**
 * Repository credentials (ADR 0031).
 *
 * `organization_source_control_connections` holds how an organization authenticates to a git
 * host: a `secret://` reference, never a secret. Only its status, version and update stamps
 * change after creation.
 *
 * `repository_credential_leases` records each credential lease: tenant, connection,
 * repository, ref, the signed grant and operation it is bound to, and its lifecycle. It holds
 * no credential. A lease moves only forward (ISSUED → REDEEMED → RELEASED, or to REVOKED or
 * EXPIRED from either live state), and everything except its lifecycle columns is immutable.
 *
 * Both tables force row-level security like every other tenant table.
 */
export const repositoryCredentialsSql = String.raw`
CREATE TABLE organization_source_control_connections (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 provider text NOT NULL CHECK(provider IN ('github','bitbucket')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 git_host text NOT NULL CHECK(git_host ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
 api_base_url text NOT NULL CHECK(api_base_url ~ '^https?://' AND length(api_base_url) <= 300),
 credential_mode text NOT NULL CHECK(credential_mode IN ('static_token','github_app')),
 secret_ref text NOT NULL CHECK(secret_ref ~ '^secret://[a-z0-9][a-z0-9._-]{0,63}$'),
 app_id text CHECK(app_id ~ '^[0-9]{1,20}$'),
 installation_id text CHECK(installation_id ~ '^[0-9]{1,20}$'),
 allowed_repositories jsonb NOT NULL CHECK(jsonb_typeof(allowed_repositories)='array'),
 status text NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(organization_id,id),
 CHECK((credential_mode='github_app') = (app_id IS NOT NULL AND installation_id IS NOT NULL)),
 CHECK(credential_mode<>'github_app' OR provider='github'),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE UNIQUE INDEX source_control_one_active_per_host
 ON organization_source_control_connections(organization_id,git_host) WHERE status='ACTIVE';
CREATE FUNCTION af_source_control_connection_status_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.provider, NEW.name, NEW.git_host, NEW.api_base_url,
      NEW.credential_mode, NEW.secret_ref, NEW.app_id, NEW.installation_id,
      NEW.allowed_repositories, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.provider, OLD.name, OLD.git_host, OLD.api_base_url,
      OLD.credential_mode, OLD.secret_ref, OLD.app_id, OLD.installation_id,
      OLD.allowed_repositories, OLD.created_by, OLD.created_at)
     OR OLD.status='DISABLED' THEN
    RAISE EXCEPTION 'SOURCE_CONTROL_CONNECTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_control_connections_status_only BEFORE UPDATE ON organization_source_control_connections
 FOR EACH ROW EXECUTE FUNCTION af_source_control_connection_status_only();
CREATE TRIGGER source_control_connections_no_delete BEFORE DELETE ON organization_source_control_connections
 FOR EACH ROW EXECUTE FUNCTION af_reject('SOURCE_CONTROL_CONNECTION_IMMUTABLE');

CREATE TABLE repository_credential_leases (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 connection_id text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('github','bitbucket')),
 repository text NOT NULL CHECK(repository ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9_.-]{1,100}$'),
 repository_url text NOT NULL CHECK(repository_url ~ '^https://' AND length(repository_url) <= 2048),
 ref text NOT NULL CHECK(length(ref) BETWEEN 1 AND 200),
 operation_kind text NOT NULL CHECK(operation_kind='git.checkout'),
 operation_digest text NOT NULL CHECK(operation_digest ~ '^[a-f0-9]{64}$'),
 grant_id text NOT NULL UNIQUE,
 request_id text NOT NULL,
 run_id text NOT NULL,
 employee_id text NOT NULL,
 agent_id text NOT NULL,
 issued_to_runtime text NOT NULL,
 status text NOT NULL CHECK(status IN ('ISSUED','REDEEMED','RELEASED','REVOKED','EXPIRED')),
 issued_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 redeemed_at timestamptz,
 redeemed_by text,
 released_at timestamptz,
 revoked_at timestamptz,
 revoked_by text,
 revoke_reason text CHECK(revoke_reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 outcome text CHECK(outcome IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','INTERRUPTED')),
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 CHECK(expires_at > issued_at),
 CHECK(status<>'ISSUED' OR (redeemed_at IS NULL AND released_at IS NULL AND revoked_at IS NULL)),
 CHECK((redeemed_at IS NULL) = (redeemed_by IS NULL)),
 CHECK(status<>'REDEEMED' OR redeemed_at IS NOT NULL),
 CHECK(status<>'RELEASED' OR (redeemed_at IS NOT NULL AND released_at IS NOT NULL)),
 CHECK(status<>'REVOKED' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
 FOREIGN KEY(organization_id,connection_id)
  REFERENCES organization_source_control_connections(organization_id,id),
 FOREIGN KEY(request_id) REFERENCES agent_action_requests(id),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE INDEX repository_credential_leases_live ON repository_credential_leases(expires_at)
 WHERE status IN ('ISSUED','REDEEMED');
CREATE INDEX repository_credential_leases_run ON repository_credential_leases(organization_id,run_id);
CREATE INDEX repository_credential_leases_recent ON repository_credential_leases(organization_id,seq);
CREATE FUNCTION af_repository_credential_lease_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.connection_id, NEW.provider, NEW.repository,
      NEW.repository_url, NEW.ref, NEW.operation_kind, NEW.operation_digest, NEW.grant_id,
      NEW.request_id, NEW.run_id, NEW.employee_id, NEW.agent_id, NEW.issued_to_runtime,
      NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.connection_id, OLD.provider, OLD.repository,
      OLD.repository_url, OLD.ref, OLD.operation_kind, OLD.operation_digest, OLD.grant_id,
      OLD.request_id, OLD.run_id, OLD.employee_id, OLD.agent_id, OLD.issued_to_runtime,
      OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'CREDENTIAL_LEASE_IMMUTABLE';
  END IF;
  IF NOT (
       (OLD.status='ISSUED' AND NEW.status IN ('REDEEMED','REVOKED','EXPIRED'))
    OR (OLD.status='REDEEMED' AND NEW.status IN ('RELEASED','REVOKED','EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'CREDENTIAL_LEASE_TRANSITION_INVALID';
  END IF;
  IF OLD.redeemed_at IS NOT NULL AND (NEW.redeemed_at, NEW.redeemed_by)
     IS DISTINCT FROM (OLD.redeemed_at, OLD.redeemed_by) THEN
    RAISE EXCEPTION 'CREDENTIAL_LEASE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repository_credential_leases_transition BEFORE UPDATE ON repository_credential_leases
 FOR EACH ROW EXECUTE FUNCTION af_repository_credential_lease_transition();
CREATE TRIGGER repository_credential_leases_no_delete BEFORE DELETE ON repository_credential_leases
 FOR EACH ROW EXECUTE FUNCTION af_reject('CREDENTIAL_LEASE_IMMUTABLE');

ALTER TABLE organization_source_control_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_source_control_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_source_control_connections
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());
ALTER TABLE repository_credential_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_credential_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repository_credential_leases
 USING (organization_id = af_current_organization())
 WITH CHECK (organization_id = af_current_organization());

GRANT SELECT, INSERT, UPDATE ON organization_source_control_connections, repository_credential_leases
 TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_source_control_connections,
 repository_credential_leases TO af_platform;
`;
