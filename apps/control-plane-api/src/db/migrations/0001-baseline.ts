/**
 * PostgreSQL baseline (ADR 0018): the control-plane schema as of SQLite migration 011, with
 * row-level security on every tenant table. Differences from SQLite:
 * - triggers are PL/pgSQL and raise the same codes;
 * - case-insensitive uniqueness uses `lower()` indexes;
 * - `messages` and `agent_assignments` carry `organization_id` so they can be isolated;
 * - `provisioning_requests` and `audit_events` get an insertion sequence instead of `rowid`;
 * - integers are `bigint` (epoch-millisecond expiries exceed 32 bits).
 */
export const baselineSql = String.raw`
CREATE FUNCTION af_current_organization() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.organization_id', true), '') $$;

CREATE FUNCTION af_json_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  PERFORM value::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

CREATE FUNCTION af_now_iso() RETURNS text LANGUAGE sql VOLATILE AS
$$ SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Raises its first trigger argument: append-only and immutable tables.
CREATE FUNCTION af_reject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END $$;

-- Tenants -------------------------------------------------------------------------------------
CREATE TABLE organizations (
 id text PRIMARY KEY,
 name text NOT NULL,
 slug text NOT NULL UNIQUE,
 legal_name text NOT NULL DEFAULT '',
 code text,
 website text NOT NULL DEFAULT '',
 industry text NOT NULL DEFAULT '',
 country text NOT NULL DEFAULT '',
 timezone text NOT NULL DEFAULT 'UTC',
 locale text NOT NULL DEFAULT 'en',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','disabled')),
 version bigint NOT NULL DEFAULT 1,
 created_at text,
 updated_at text,
 updated_by text
);
CREATE UNIQUE INDEX organization_code_unique ON organizations(lower(code));
CREATE FUNCTION organization_profile_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.code := coalesce(NEW.code, upper(NEW.slug));
  NEW.created_at := coalesce(NEW.created_at, af_now_iso());
  NEW.updated_at := coalesce(NEW.updated_at, af_now_iso());
  RETURN NEW;
END $$;
CREATE TRIGGER organization_profile_defaults BEFORE INSERT ON organizations
 FOR EACH ROW EXECUTE FUNCTION organization_profile_defaults();

-- Users are global authentication principals. Employment and access are tenant-owned.
CREATE TABLE users (
 id text PRIMARY KEY,
 email text NOT NULL,
 display_name text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at text NOT NULL
);
CREATE UNIQUE INDEX users_email_unique ON users(lower(email));

CREATE TABLE employees (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 display_name text NOT NULL,
 email text NOT NULL,
 role text NOT NULL,
 team text NOT NULL,
 user_id text REFERENCES users(id),
 employee_number text,
 employment_type text NOT NULL DEFAULT 'employee' CHECK(employment_type IN ('employee','contractor','external')),
 employment_status text NOT NULL DEFAULT 'active' CHECK(employment_status IN ('active','inactive')),
 version bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX employees_tenant_id ON employees(organization_id,id);
CREATE UNIQUE INDEX employee_email_per_tenant ON employees(organization_id,lower(email));
CREATE UNIQUE INDEX employee_user_per_tenant ON employees(organization_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX employee_number_per_tenant ON employees(organization_id,employee_number) WHERE employee_number IS NOT NULL;
CREATE UNIQUE INDEX employee_user_tenant_link ON employees(organization_id,id,user_id);

CREATE TABLE organization_memberships (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 user_id text NOT NULL REFERENCES users(id),
 employee_id text NOT NULL,
 security_role text NOT NULL CHECK(security_role IN ('ADMIN','EMPLOYEE')),
 membership_status text NOT NULL CHECK(membership_status IN ('pending','active','suspended')),
 version bigint NOT NULL DEFAULT 1,
 joined_at text NOT NULL,
 updated_at text NOT NULL,
 invited_by text,
 UNIQUE(organization_id,user_id), UNIQUE(organization_id,employee_id),
 FOREIGN KEY(organization_id,employee_id,user_id) REFERENCES employees(organization_id,id,user_id)
);
CREATE INDEX memberships_user_status ON organization_memberships(user_id,membership_status);

-- Sign-in (platform scope only) ---------------------------------------------------------------
CREATE TABLE identities (
 issuer text NOT NULL,
 subject text NOT NULL,
 employee_id text NOT NULL REFERENCES employees(id),
 enabled bigint NOT NULL,
 user_id text REFERENCES users(id),
 PRIMARY KEY (issuer, subject)
);
CREATE FUNCTION identity_user_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND user_id=NEW.user_id) THEN
    RAISE EXCEPTION 'IDENTITY_USER_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_user_insert BEFORE INSERT ON identities
 FOR EACH ROW EXECUTE FUNCTION identity_user_check();
CREATE TRIGGER identity_user_update BEFORE UPDATE OF user_id,employee_id ON identities
 FOR EACH ROW EXECUTE FUNCTION identity_user_check();

CREATE TABLE login_transactions (hash text PRIMARY KEY, body text NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE password_credentials (
 issuer text NOT NULL, subject text NOT NULL, hash text NOT NULL,
 PRIMARY KEY (issuer, subject), FOREIGN KEY (issuer, subject) REFERENCES identities(issuer, subject)
);
CREATE TABLE account_password_credentials (
 user_id text PRIMARY KEY REFERENCES users(id),
 hash text NOT NULL,
 updated_at text NOT NULL
);
CREATE TABLE auth_sessions (
 hash text PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL, expires_at bigint NOT NULL,
 user_id text REFERENCES users(id), organization_id text REFERENCES organizations(id)
);
CREATE INDEX account_sessions_by_user ON auth_sessions(user_id,organization_id);
CREATE TABLE invitations (
 hash text PRIMARY KEY, employee_id text NOT NULL REFERENCES employees(id),
 expires_at bigint NOT NULL, consumed bigint NOT NULL
);
CREATE TABLE password_resets (
 hash text PRIMARY KEY, employee_id text NOT NULL REFERENCES employees(id),
 expires_at bigint NOT NULL, consumed bigint NOT NULL
);
CREATE TABLE account_link_invitations (
 hash text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 employee_id text NOT NULL,
 user_id text NOT NULL REFERENCES users(id),
 expires_at bigint NOT NULL,
 consumed bigint NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 invited_by text,
 FOREIGN KEY(organization_id,employee_id,user_id) REFERENCES employees(organization_id,id,user_id),
 FOREIGN KEY(organization_id,invited_by) REFERENCES employees(organization_id,id)
);
CREATE INDEX account_link_pending ON account_link_invitations(organization_id,employee_id,consumed);

-- Agents, conversations and approvals -----------------------------------------------------------
CREATE TABLE catalog_blueprint_versions (
 blueprint_id text NOT NULL,
 version text NOT NULL,
 digest text NOT NULL CHECK(length(digest)=64),
 content text NOT NULL CHECK(af_json_valid(content)),
 registered_at text NOT NULL,
 PRIMARY KEY(blueprint_id,version)
);
CREATE TRIGGER catalog_versions_no_update BEFORE UPDATE ON catalog_blueprint_versions
 FOR EACH ROW EXECUTE FUNCTION af_reject('CATALOG_VERSION_IMMUTABLE');
CREATE TRIGGER catalog_versions_no_delete BEFORE DELETE ON catalog_blueprint_versions
 FOR EACH ROW EXECUTE FUNCTION af_reject('CATALOG_VERSION_IMMUTABLE');

CREATE TABLE organization_agent_installations (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 blueprint_id text NOT NULL,
 blueprint_version text NOT NULL,
 configuration text NOT NULL CHECK(af_json_valid(configuration)),
 status text NOT NULL CHECK(status IN ('ACTIVE','RETIRED')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL,
 created_at text NOT NULL,
 updated_by text NOT NULL,
 updated_at text NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(blueprint_id,blueprint_version) REFERENCES catalog_blueprint_versions(blueprint_id,version),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE UNIQUE INDEX installation_active_name ON organization_agent_installations(organization_id,lower(name))
 WHERE status='ACTIVE';
CREATE TRIGGER installation_identity_immutable BEFORE UPDATE OF id,organization_id,blueprint_id,created_by,created_at
 ON organization_agent_installations FOR EACH ROW EXECUTE FUNCTION af_reject('INSTALLATION_IDENTITY_IMMUTABLE');
CREATE TRIGGER installation_retired_final BEFORE UPDATE ON organization_agent_installations
 FOR EACH ROW WHEN (OLD.status='RETIRED') EXECUTE FUNCTION af_reject('INSTALLATION_RETIRED');
CREATE TRIGGER installation_no_delete BEFORE DELETE ON organization_agent_installations
 FOR EACH ROW EXECUTE FUNCTION af_reject('INSTALLATION_HISTORY_RETAINED');

CREATE TABLE agents (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL,
 department text NOT NULL,
 team text NOT NULL,
 status text NOT NULL,
 capabilities text NOT NULL,
 installation_id text
);
CREATE UNIQUE INDEX agents_tenant_id ON agents(organization_id,id);
CREATE INDEX agents_installation ON agents(organization_id,installation_id) WHERE installation_id IS NOT NULL;
CREATE FUNCTION agents_installation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization_agent_installations WHERE id=NEW.installation_id
      AND organization_id=NEW.organization_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'INSTALLATION_SCOPE_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agents_installation_scope BEFORE INSERT ON agents
 FOR EACH ROW WHEN (NEW.installation_id IS NOT NULL) EXECUTE FUNCTION agents_installation_scope();
CREATE TRIGGER agents_installation_immutable BEFORE UPDATE OF installation_id ON agents
 FOR EACH ROW EXECUTE FUNCTION af_reject('AGENT_INSTALLATION_IMMUTABLE');

CREATE TABLE agent_manifests (
 agent_id text PRIMARY KEY REFERENCES agents(id),
 organization_id text NOT NULL REFERENCES organizations(id),
 employee_id text NOT NULL REFERENCES employees(id),
 body text NOT NULL
);
CREATE TABLE agent_assignments (
 agent_id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 created_by text NOT NULL,
 created_at text NOT NULL,
 FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id),
 FOREIGN KEY (organization_id, created_by) REFERENCES employees(organization_id, id)
);
CREATE TABLE admin_agent_batches (
 organization_id text NOT NULL REFERENCES organizations(id),
 request_id text NOT NULL, body_hash text NOT NULL, result text NOT NULL,
 PRIMARY KEY (organization_id, request_id)
);
CREATE TABLE provisioning_requests (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 employee_id text NOT NULL REFERENCES employees(id),
 body text NOT NULL,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE TABLE conversations (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 employee_id text NOT NULL REFERENCES employees(id),
 agent_id text NOT NULL REFERENCES agents(id),
 title text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
);
CREATE INDEX idx_conversations_employee ON conversations(employee_id, updated_at);
CREATE UNIQUE INDEX conversations_tenant_id ON conversations(organization_id,id);
CREATE TABLE messages (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 conversation_id text NOT NULL,
 author text NOT NULL,
 content text NOT NULL,
 created_at text NOT NULL,
 FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations(organization_id, id)
);
CREATE INDEX messages_conversation ON messages(organization_id, conversation_id, created_at);

CREATE TABLE approvals (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 requested_by text NOT NULL,
 action text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
 risk text NOT NULL, summary text NOT NULL, status text NOT NULL,
 decided_by text, decided_at text, created_at text NOT NULL,
 run_id text, step_id text, expires_at text
);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);
CREATE INDEX approvals_run ON approvals(organization_id,run_id) WHERE run_id IS NOT NULL;
CREATE INDEX approvals_expiry ON approvals(status,expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE qa_runs (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 employee_id text NOT NULL,
 conversation_id text NOT NULL REFERENCES conversations(id),
 story_key text NOT NULL, target_url text NOT NULL,
 status text NOT NULL, plan text NOT NULL,
 approval_id text NOT NULL UNIQUE REFERENCES approvals(id),
 created_at text NOT NULL
);
CREATE TABLE llm_key_bindings (
 id text PRIMARY KEY, organization_id text NOT NULL, employee_id text,
 provider text NOT NULL, key_source text NOT NULL, secret_ref text NOT NULL,
 created_at text NOT NULL,
 CHECK (length(secret_ref) > 0)
);
CREATE TABLE audit_events (
 id text PRIMARY KEY, organization_id text NOT NULL, actor_id text NOT NULL,
 event_type text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
 metadata text NOT NULL, created_at text NOT NULL,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX idx_audit_resource ON audit_events(resource_type, resource_id);
CREATE INDEX audit_events_tenant ON audit_events(organization_id, seq);

-- Organization structure --------------------------------------------------------------------------
CREATE TABLE organizational_units (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 parent_id text,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 unit_type text NOT NULL CHECK(unit_type IN ('business_unit','division','department','sub_department','team','squad','pod','chapter','guild','other')),
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version bigint NOT NULL DEFAULT 1,
 created_at text NOT NULL,
 updated_at text NOT NULL,
 created_by text NOT NULL,
 updated_by text NOT NULL,
 head_position_id text,
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,parent_id) REFERENCES organizational_units(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id),
 CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX units_parent ON organizational_units(organization_id,parent_id,status);
CREATE INDEX units_name ON organizational_units(organization_id,status,name,id);
CREATE UNIQUE INDEX one_unit_per_head_position ON organizational_units(organization_id,head_position_id) WHERE head_position_id IS NOT NULL;

CREATE TABLE organization_change_events (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 actor_id text NOT NULL,
 action text NOT NULL,
 resource_type text NOT NULL,
 resource_id text NOT NULL,
 before_json text,
 after_json text,
 request_id text NOT NULL,
 created_at text NOT NULL,
 FOREIGN KEY(organization_id,actor_id) REFERENCES employees(organization_id,id)
);
CREATE INDEX organization_changes_time ON organization_change_events(organization_id,created_at,id);
CREATE TRIGGER organization_changes_no_update BEFORE UPDATE ON organization_change_events
 FOR EACH ROW EXECUTE FUNCTION af_reject('AUDIT_IMMUTABLE');
CREATE TRIGGER organization_changes_no_delete BEFORE DELETE ON organization_change_events
 FOR EACH ROW EXECUTE FUNCTION af_reject('AUDIT_IMMUTABLE');

CREATE TABLE job_families (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version bigint NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL,
 created_by text NOT NULL, updated_by text NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE TABLE job_disciplines (
 job_family_id text NOT NULL,
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version bigint NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL,
 created_by text NOT NULL, updated_by text NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,job_family_id) REFERENCES job_families(organization_id,id)
);
CREATE INDEX disciplines_family ON job_disciplines(organization_id,job_family_id,status);
CREATE TABLE roles (
 job_family_id text NOT NULL,
 discipline_id text NOT NULL,
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version bigint NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL,
 created_by text NOT NULL, updated_by text NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,job_family_id) REFERENCES job_families(organization_id,id),
 FOREIGN KEY(organization_id,discipline_id) REFERENCES job_disciplines(organization_id,id)
);
CREATE INDEX roles_discipline ON roles(organization_id,discipline_id,status);
CREATE TABLE job_levels (
 rank bigint NOT NULL CHECK(rank>=0),
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version bigint NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL,
 created_by text NOT NULL, updated_by text NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE TABLE positions (
 organizational_unit_id text NOT NULL,
 role_id text NOT NULL,
 job_level_id text NOT NULL,
 reports_to_position_id text,
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version bigint NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL,
 created_by text NOT NULL, updated_by text NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,organizational_unit_id) REFERENCES organizational_units(organization_id,id),
 FOREIGN KEY(organization_id,role_id) REFERENCES roles(organization_id,id),
 FOREIGN KEY(organization_id,job_level_id) REFERENCES job_levels(organization_id,id),
 FOREIGN KEY(organization_id,reports_to_position_id) REFERENCES positions(organization_id,id),
 CHECK(reports_to_position_id IS NULL OR reports_to_position_id<>id)
);
CREATE INDEX positions_unit ON positions(organization_id,organizational_unit_id,status);
CREATE INDEX positions_role ON positions(organization_id,role_id,status);
ALTER TABLE organizational_units ADD FOREIGN KEY (head_position_id) REFERENCES positions(id);

CREATE TABLE organizational_unit_memberships (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 organizational_unit_id text NOT NULL,
 employee_id text NOT NULL,
 membership_type text NOT NULL CHECK(membership_type IN ('member','lead','manager','owner','contributor')),
 is_primary bigint NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
 created_at text NOT NULL,
 created_by text NOT NULL,
 started_at text NOT NULL,
 ended_at text,
 version bigint NOT NULL DEFAULT 1,
 FOREIGN KEY(organization_id,organizational_unit_id) REFERENCES organizational_units(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX current_unit_member ON organizational_unit_memberships(organization_id,organizational_unit_id,employee_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX one_primary_unit ON organizational_unit_memberships(organization_id,employee_id) WHERE is_primary=1 AND ended_at IS NULL;
CREATE INDEX unit_membership_history ON organizational_unit_memberships(organization_id,organizational_unit_id,ended_at,started_at);

CREATE TABLE organization_domains (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 domain text NOT NULL,
 domain_type text NOT NULL CHECK(domain_type IN ('custom_domain','platform_subdomain','internal')),
 is_primary bigint NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
 verification_status text NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','disabled')),
 verification_token text NOT NULL,
 verified_at text,
 created_at text NOT NULL, updated_at text NOT NULL,
 created_by text NOT NULL,
 version bigint NOT NULL DEFAULT 1,
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 CHECK(is_primary=0 OR verification_status='verified')
);
CREATE UNIQUE INDEX organization_domain_unique ON organization_domains(lower(domain));
CREATE UNIQUE INDEX primary_domain_per_tenant ON organization_domains(organization_id) WHERE is_primary=1;
CREATE INDEX domain_tenant ON organization_domains(organization_id,verification_status);

CREATE TABLE employee_position_assignments (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 employee_id text NOT NULL,
 position_id text NOT NULL,
 started_at text NOT NULL, ended_at text,
 created_by text NOT NULL,
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,position_id) REFERENCES positions(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id)
);
CREATE UNIQUE INDEX employee_current_position ON employee_position_assignments(organization_id,employee_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX position_current_occupant ON employee_position_assignments(organization_id,position_id) WHERE ended_at IS NULL;

CREATE FUNCTION units_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT OLD.id UNION SELECT u.id FROM organizational_units u JOIN descendants d ON u.parent_id=d.id
      WHERE u.organization_id=OLD.organization_id
    ) SELECT id FROM descendants) THEN
    RAISE EXCEPTION 'HIERARCHY_CYCLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER units_no_cycle BEFORE UPDATE OF parent_id ON organizational_units
 FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL) EXECUTE FUNCTION units_no_cycle();
CREATE FUNCTION units_active_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizational_units WHERE id=NEW.parent_id
      AND organization_id=NEW.organization_id AND status='active') THEN
    RAISE EXCEPTION 'PARENT_INACTIVE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER units_active_parent_insert BEFORE INSERT ON organizational_units
 FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL) EXECUTE FUNCTION units_active_parent();
CREATE TRIGGER units_active_parent_update BEFORE UPDATE ON organizational_units
 FOR EACH ROW WHEN (NEW.status='active' AND NEW.parent_id IS NOT NULL) EXECUTE FUNCTION units_active_parent();
-- One function keeps SQLite's order of checks: children, positions, then members.
CREATE FUNCTION units_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizational_units WHERE parent_id=OLD.id
      AND organization_id=OLD.organization_id AND status='active') THEN
    RAISE EXCEPTION 'UNIT_HAS_CHILDREN';
  END IF;
  IF EXISTS (SELECT 1 FROM positions WHERE organization_id=OLD.organization_id
      AND organizational_unit_id=OLD.id AND status='active') THEN
    RAISE EXCEPTION 'UNIT_HAS_CHILDREN';
  END IF;
  IF EXISTS (SELECT 1 FROM organizational_unit_memberships WHERE organizational_unit_id=OLD.id
      AND organization_id=OLD.organization_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'UNIT_HAS_MEMBERS';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER units_archive BEFORE UPDATE OF status ON organizational_units
 FOR EACH ROW WHEN (NEW.status='archived') EXECUTE FUNCTION units_archive();
CREATE FUNCTION unit_head_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM positions WHERE id=NEW.head_position_id AND organization_id=NEW.organization_id
      AND organizational_unit_id=NEW.id AND status='active') THEN
    RAISE EXCEPTION 'INVALID_HEAD_POSITION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unit_head_insert BEFORE INSERT ON organizational_units
 FOR EACH ROW WHEN (NEW.head_position_id IS NOT NULL) EXECUTE FUNCTION unit_head_check();
CREATE TRIGGER unit_head_update BEFORE UPDATE OF head_position_id,organization_id ON organizational_units
 FOR EACH ROW WHEN (NEW.head_position_id IS NOT NULL) EXECUTE FUNCTION unit_head_check();

CREATE FUNCTION position_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reports_to_position_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT OLD.id UNION SELECT p.id FROM positions p JOIN descendants d ON p.reports_to_position_id=d.id
      WHERE p.organization_id=OLD.organization_id
    ) SELECT id FROM descendants) THEN
    RAISE EXCEPTION 'HIERARCHY_CYCLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER position_no_cycle BEFORE UPDATE OF reports_to_position_id ON positions
 FOR EACH ROW WHEN (NEW.reports_to_position_id IS NOT NULL) EXECUTE FUNCTION position_no_cycle();
CREATE FUNCTION occupied_position_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM employee_position_assignments WHERE organization_id=OLD.organization_id
      AND position_id=OLD.id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'POSITION_OCCUPIED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER occupied_position_archive BEFORE UPDATE OF status ON positions
 FOR EACH ROW WHEN (NEW.status='archived') EXECUTE FUNCTION occupied_position_archive();
CREATE FUNCTION head_position_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizational_units WHERE head_position_id=OLD.id AND organization_id=OLD.organization_id
      AND (NEW.organizational_unit_id<>OLD.organizational_unit_id OR NEW.organization_id<>OLD.organization_id OR NEW.status<>'active')) THEN
    RAISE EXCEPTION 'HEAD_POSITION_IN_USE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER head_position_move BEFORE UPDATE OF organizational_unit_id,organization_id,status ON positions
 FOR EACH ROW EXECUTE FUNCTION head_position_move();
CREATE FUNCTION role_family_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM job_disciplines WHERE organization_id=NEW.organization_id
      AND id=NEW.discipline_id AND job_family_id=NEW.job_family_id) THEN
    RAISE EXCEPTION 'JOB_FAMILY_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_family_insert BEFORE INSERT ON roles FOR EACH ROW EXECUTE FUNCTION role_family_check();
CREATE TRIGGER role_family_update BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION role_family_check();
CREATE FUNCTION discipline_family_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE organization_id=OLD.organization_id
      AND discipline_id=OLD.id AND job_family_id<>NEW.job_family_id) THEN
    RAISE EXCEPTION 'JOB_FAMILY_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discipline_family_update BEFORE UPDATE OF job_family_id ON job_disciplines
 FOR EACH ROW EXECUTE FUNCTION discipline_family_update();
CREATE FUNCTION assignment_active_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM employees WHERE organization_id=NEW.organization_id AND id=NEW.employee_id AND employment_status='active')
     OR NOT EXISTS(SELECT 1 FROM positions WHERE organization_id=NEW.organization_id AND id=NEW.position_id AND status='active') THEN
    RAISE EXCEPTION 'ASSIGNMENT_INACTIVE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assignment_active_dependencies BEFORE INSERT ON employee_position_assignments
 FOR EACH ROW EXECUTE FUNCTION assignment_active_dependencies();

-- Agent execution ----------------------------------------------------------------------------------
CREATE TABLE agent_threads (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 employee_id text NOT NULL,
 agent_id text NOT NULL,
 conversation_id text,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 status text NOT NULL CHECK(status IN ('ACTIVE','ARCHIVED')),
 created_at text NOT NULL,
 updated_at text NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES conversations(organization_id,id)
);
CREATE INDEX agent_threads_conversation ON agent_threads(organization_id,conversation_id,agent_id,status);

CREATE TABLE agent_runs (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 thread_id text NOT NULL,
 employee_id text NOT NULL,
 agent_id text NOT NULL,
 manifest_id text,
 manifest_api_version text CHECK(manifest_api_version IN ('agents-foundry/v1','agents-foundry/v2')),
 manifest_key_id text,
 task text NOT NULL CHECK(af_json_valid(task)),
 runtime_profile text NOT NULL,
 status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL','COMPLETED','FAILED','CANCELLED')),
 status_reason text,
 legacy_qa_run_id text UNIQUE REFERENCES qa_runs(id),
 runtime_sequence bigint NOT NULL DEFAULT 0 CHECK(runtime_sequence>=0),
 created_at text NOT NULL,
 updated_at text NOT NULL,
 started_at text,
 completed_at text,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,agent_id) REFERENCES agents(organization_id,id),
 CHECK((manifest_id IS NULL) = (manifest_api_version IS NULL) AND (manifest_id IS NULL) = (manifest_key_id IS NULL))
);
CREATE UNIQUE INDEX one_active_run_per_thread ON agent_runs(organization_id,thread_id)
 WHERE status IN ('QUEUED','RUNNING','WAITING_FOR_APPROVAL');
CREATE INDEX agent_runs_employee ON agent_runs(organization_id,employee_id,created_at);
CREATE INDEX agent_runs_queue ON agent_runs(status, created_at);
CREATE FUNCTION agent_runs_thread_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_threads WHERE id=NEW.thread_id AND organization_id=NEW.organization_id
      AND employee_id=NEW.employee_id AND agent_id=NEW.agent_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'RUN_THREAD_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_thread_owner BEFORE INSERT ON agent_runs
 FOR EACH ROW EXECUTE FUNCTION agent_runs_thread_owner();
CREATE TRIGGER agent_runs_identity_immutable BEFORE UPDATE OF
 id,organization_id,thread_id,employee_id,agent_id,manifest_id,manifest_api_version,manifest_key_id,task,legacy_qa_run_id,created_at
 ON agent_runs FOR EACH ROW EXECUTE FUNCTION af_reject('RUN_IDENTITY_IMMUTABLE');
CREATE TRIGGER agent_runs_terminal_immutable BEFORE UPDATE ON agent_runs
 FOR EACH ROW WHEN (OLD.status IN ('COMPLETED','FAILED','CANCELLED')) EXECUTE FUNCTION af_reject('RUN_TERMINAL');
CREATE TRIGGER agent_runs_no_delete BEFORE DELETE ON agent_runs
 FOR EACH ROW EXECUTE FUNCTION af_reject('RUN_HISTORY_RETAINED');

CREATE TABLE agent_run_steps (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 run_id text NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0),
 kind text NOT NULL CHECK(kind IN ('PLAN','MODEL','TOOL','ACTION','MESSAGE')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 status text NOT NULL CHECK(status IN ('PENDING','RUNNING','WAITING_FOR_APPROVAL','COMPLETED','FAILED','SKIPPED','CANCELLED')),
 detail text NOT NULL DEFAULT '{}' CHECK(af_json_valid(detail)),
 created_at text NOT NULL,
 started_at text,
 completed_at text,
 UNIQUE(organization_id,id),
 UNIQUE(run_id,sequence),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE TRIGGER agent_run_steps_identity_immutable BEFORE UPDATE OF id,organization_id,run_id,sequence,kind,created_at
 ON agent_run_steps FOR EACH ROW EXECUTE FUNCTION af_reject('STEP_IDENTITY_IMMUTABLE');
CREATE TRIGGER agent_run_steps_no_delete BEFORE DELETE ON agent_run_steps
 FOR EACH ROW EXECUTE FUNCTION af_reject('RUN_HISTORY_RETAINED');

CREATE TABLE agent_events (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 thread_id text NOT NULL,
 run_id text NOT NULL,
 step_id text,
 sequence bigint NOT NULL CHECK(sequence>0),
 runtime_sequence bigint CHECK(runtime_sequence>0),
 event_type text NOT NULL,
 source text NOT NULL CHECK(source IN ('CONTROL_PLANE','RUNTIME')),
 actor_id text,
 payload text NOT NULL CHECK(af_json_valid(payload)),
 payload_hash text NOT NULL CHECK(length(payload_hash)=64),
 occurred_at text NOT NULL,
 recorded_at text NOT NULL,
 UNIQUE(run_id,sequence),
 UNIQUE(run_id,runtime_sequence),
 CHECK((source='RUNTIME') = (runtime_sequence IS NOT NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE FUNCTION run_scope_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND thread_id=NEW.thread_id AND organization_id=NEW.organization_id)
     OR (NEW.step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run_steps WHERE id=NEW.step_id AND run_id=NEW.run_id)) THEN
    RAISE EXCEPTION '%', TG_ARGV[0];
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_events_scope BEFORE INSERT ON agent_events
 FOR EACH ROW EXECUTE FUNCTION run_scope_check('EVENT_SCOPE_MISMATCH');
CREATE TRIGGER agent_events_no_update BEFORE UPDATE ON agent_events
 FOR EACH ROW EXECUTE FUNCTION af_reject('AGENT_EVENTS_APPEND_ONLY');
CREATE TRIGGER agent_events_no_delete BEFORE DELETE ON agent_events
 FOR EACH ROW EXECUTE FUNCTION af_reject('AGENT_EVENTS_APPEND_ONLY');

CREATE TABLE agent_artifacts (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 thread_id text NOT NULL,
 run_id text NOT NULL,
 step_id text,
 artifact_type text NOT NULL,
 media_type text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
 storage_reference text NOT NULL UNIQUE CHECK(storage_reference LIKE 'artifact://%'),
 checksum_sha256 text NOT NULL CHECK(length(checksum_sha256)=64),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 retention_policy text NOT NULL CHECK(retention_policy IN ('EPHEMERAL','STANDARD_30D','EXTENDED_365D','LEGAL_HOLD')),
 created_at text NOT NULL,
 created_by text NOT NULL,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,thread_id) REFERENCES agent_threads(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE INDEX agent_artifacts_run ON agent_artifacts(organization_id,run_id,created_at);
CREATE TRIGGER agent_artifacts_scope BEFORE INSERT ON agent_artifacts
 FOR EACH ROW EXECUTE FUNCTION run_scope_check('ARTIFACT_SCOPE_MISMATCH');
CREATE TRIGGER agent_artifacts_no_update BEFORE UPDATE ON agent_artifacts
 FOR EACH ROW EXECUTE FUNCTION af_reject('ARTIFACTS_IMMUTABLE');
CREATE TRIGGER agent_artifacts_no_delete BEFORE DELETE ON agent_artifacts
 FOR EACH ROW EXECUTE FUNCTION af_reject('ARTIFACTS_IMMUTABLE');

CREATE FUNCTION approvals_run_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.run_id IS NOT NULL OR OLD.step_id IS NOT NULL) THEN
    RAISE EXCEPTION 'APPROVAL_RUN_LINK_IMMUTABLE';
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.run_id IS NULL)
     OR (NEW.run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM agent_runs WHERE id=NEW.run_id AND organization_id=NEW.organization_id))
     OR (NEW.step_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM agent_run_steps WHERE id=NEW.step_id AND run_id=NEW.run_id AND organization_id=NEW.organization_id)) THEN
    RAISE EXCEPTION 'APPROVAL_RUN_SCOPE_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_run_link BEFORE UPDATE OF run_id,step_id ON approvals
 FOR EACH ROW EXECUTE FUNCTION approvals_run_link();
CREATE TRIGGER approvals_run_link_insert BEFORE INSERT ON approvals
 FOR EACH ROW WHEN (NEW.run_id IS NOT NULL OR NEW.step_id IS NOT NULL) EXECUTE FUNCTION approvals_run_link();

CREATE TABLE agent_run_leases (
 run_id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 session_id text NOT NULL UNIQUE,
 runtime_id text NOT NULL CHECK(length(runtime_id) BETWEEN 1 AND 120),
 state text NOT NULL CHECK(state IN ('ACTIVE','CLOSED')),
 last_command text,
 claimed_at text NOT NULL,
 heartbeat_at text NOT NULL,
 lease_expires_at text NOT NULL,
 closed_at text,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE INDEX agent_run_leases_runtime ON agent_run_leases(runtime_id,state);
CREATE TRIGGER agent_run_leases_identity_immutable BEFORE UPDATE OF run_id,organization_id,claimed_at
 ON agent_run_leases FOR EACH ROW EXECUTE FUNCTION af_reject('LEASE_IDENTITY_IMMUTABLE');
CREATE TRIGGER agent_run_leases_closed_immutable BEFORE UPDATE ON agent_run_leases
 FOR EACH ROW WHEN (OLD.state='CLOSED') EXECUTE FUNCTION af_reject('LEASE_CLOSED');
CREATE TRIGGER agent_run_leases_no_delete BEFORE DELETE ON agent_run_leases
 FOR EACH ROW EXECUTE FUNCTION af_reject('RUN_HISTORY_RETAINED');

CREATE TABLE runtime_request_nonces (
 runtime_id text NOT NULL,
 nonce text NOT NULL,
 expires_at bigint NOT NULL,
 PRIMARY KEY(runtime_id,nonce)
);
CREATE INDEX runtime_request_nonces_expiry ON runtime_request_nonces(expires_at);

-- Action gateway ------------------------------------------------------------------------------------
CREATE TABLE organization_connector_connections (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 provider text NOT NULL CHECK(provider IN ('jira','github')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 base_url text NOT NULL CHECK(base_url LIKE 'http%'),
 secret_ref text NOT NULL CHECK(secret_ref LIKE 'secret://%'),
 settings text NOT NULL CHECK(af_json_valid(settings)),
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
CREATE UNIQUE INDEX connector_one_active_per_provider ON organization_connector_connections(organization_id,provider)
 WHERE status='ACTIVE';
CREATE TRIGGER connector_connections_identity_immutable BEFORE UPDATE OF id,organization_id,provider,created_by,created_at
 ON organization_connector_connections FOR EACH ROW EXECUTE FUNCTION af_reject('CONNECTION_IDENTITY_IMMUTABLE');
CREATE TRIGGER connector_connections_no_delete BEFORE DELETE ON organization_connector_connections
 FOR EACH ROW EXECUTE FUNCTION af_reject('CONNECTION_HISTORY_RETAINED');

CREATE TABLE agent_action_requests (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 run_id text NOT NULL,
 step_id text NOT NULL,
 runtime_id text NOT NULL,
 action text NOT NULL,
 tool_id text NOT NULL,
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 decision text NOT NULL CHECK(decision IN ('ALLOWED','DENIED','APPROVAL_REQUIRED')),
 risk text NOT NULL CHECK(risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
 reason text NOT NULL,
 approval_id text REFERENCES approvals(id),
 created_at text NOT NULL,
 parameters text CHECK(parameters IS NULL OR af_json_valid(parameters)),
 policy_id text,
 policy_version text,
 change_set text CHECK(change_set IS NULL OR af_json_valid(change_set)),
 CHECK((decision='APPROVAL_REQUIRED') = (approval_id IS NOT NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,step_id) REFERENCES agent_run_steps(organization_id,id)
);
CREATE INDEX agent_action_requests_run ON agent_action_requests(organization_id,run_id,created_at);
CREATE TRIGGER agent_action_requests_no_update BEFORE UPDATE ON agent_action_requests
 FOR EACH ROW EXECUTE FUNCTION af_reject('ACTION_REQUESTS_APPEND_ONLY');
CREATE TRIGGER agent_action_requests_no_delete BEFORE DELETE ON agent_action_requests
 FOR EACH ROW EXECUTE FUNCTION af_reject('ACTION_REQUESTS_APPEND_ONLY');

CREATE TABLE organization_action_policies (
 organization_id text NOT NULL REFERENCES organizations(id),
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 120),
 outcome text NOT NULL CHECK(outcome IN ('REQUIRE_APPROVAL','DENY')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 updated_by text NOT NULL,
 updated_at text NOT NULL,
 PRIMARY KEY(organization_id,action),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);

CREATE TABLE agent_action_executions (
 request_id text PRIMARY KEY REFERENCES agent_action_requests(id),
 organization_id text NOT NULL REFERENCES organizations(id),
 run_id text NOT NULL,
 connection_id text,
 status text NOT NULL CHECK(status IN ('DISPATCHING','SUCCEEDED','FAILED')),
 result text CHECK(result IS NULL OR af_json_valid(result)),
 error_code text,
 started_at text NOT NULL,
 completed_at text,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES organization_connector_connections(organization_id,id)
);
CREATE FUNCTION agent_action_executions_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'DISPATCHING' OR NEW.status NOT IN ('SUCCEEDED','FAILED') OR NEW.request_id<>OLD.request_id
     OR NEW.organization_id<>OLD.organization_id OR NEW.run_id<>OLD.run_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.started_at<>OLD.started_at THEN
    RAISE EXCEPTION 'ACTION_EXECUTION_FINAL';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_action_executions_transition BEFORE UPDATE ON agent_action_executions
 FOR EACH ROW EXECUTE FUNCTION agent_action_executions_transition();
CREATE TRIGGER agent_action_executions_no_delete BEFORE DELETE ON agent_action_executions
 FOR EACH ROW EXECUTE FUNCTION af_reject('ACTION_REQUESTS_APPEND_ONLY');

CREATE TABLE agent_execution_grants (
 grant_id text PRIMARY KEY,
 request_id text NOT NULL UNIQUE REFERENCES agent_action_requests(id),
 organization_id text NOT NULL REFERENCES organizations(id),
 run_id text NOT NULL,
 operation_kind text NOT NULL,
 signed_grant text NOT NULL CHECK(af_json_valid(signed_grant)),
 issued_at text NOT NULL,
 expires_at text NOT NULL,
 FOREIGN KEY(organization_id,run_id) REFERENCES agent_runs(organization_id,id)
);
CREATE TRIGGER agent_execution_grants_no_update BEFORE UPDATE ON agent_execution_grants
 FOR EACH ROW EXECUTE FUNCTION af_reject('EXECUTION_GRANTS_IMMUTABLE');
CREATE TRIGGER agent_execution_grants_no_delete BEFORE DELETE ON agent_execution_grants
 FOR EACH ROW EXECUTE FUNCTION af_reject('EXECUTION_GRANTS_IMMUTABLE');

-- Row-level security ----------------------------------------------------------------------------
-- Every table with an organization is isolated by af_current_organization(), which is set
-- per transaction and is NULL (matching nothing) when unset. FORCE applies the policies to the
-- table owner too; only the platform role (BYPASSRLS) sees across organizations.
DO $$
DECLARE
  item text;
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'employees','organization_memberships','account_link_invitations','auth_sessions',
    'organization_agent_installations','agents','agent_manifests','agent_assignments',
    'admin_agent_batches','provisioning_requests','conversations','messages','approvals',
    'qa_runs','llm_key_bindings','audit_events','organizational_units',
    'organization_change_events','job_families','job_disciplines','roles','job_levels',
    'positions','organizational_unit_memberships','organization_domains',
    'employee_position_assignments','agent_threads','agent_runs','agent_run_steps',
    'agent_events','agent_artifacts','agent_run_leases','organization_connector_connections',
    'agent_action_requests','organization_action_policies','agent_action_executions',
    'agent_execution_grants'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', item);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = af_current_organization())'
      ' WITH CHECK (organization_id = af_current_organization())', item);
  END LOOP;
END $$;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
 USING (id = af_current_organization()) WITH CHECK (id = af_current_organization());
-- Accounts are global, but a tenant sees only accounts that are members of it.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_members ON users USING (EXISTS (
 SELECT 1 FROM organization_memberships m WHERE m.user_id = users.id));
ALTER TABLE account_password_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_password_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_members ON account_password_credentials USING (EXISTS (
 SELECT 1 FROM organization_memberships m WHERE m.user_id = account_password_credentials.user_id));

-- Privileges --------------------------------------------------------------------------------------
-- af_tenant: tenant tables only. Sign-in secrets, sessions, invitations and runtime nonces are
-- not granted at all, so tenant-scoped code cannot read them even by mistake.
GRANT USAGE ON SCHEMA public TO af_tenant, af_platform;
GRANT SELECT, INSERT, UPDATE ON
 employees, organization_memberships, organization_agent_installations, agents, agent_manifests,
 agent_assignments, admin_agent_batches, provisioning_requests, conversations, messages,
 approvals, qa_runs, llm_key_bindings, audit_events, organizational_units,
 organization_change_events, job_families, job_disciplines, roles, job_levels, positions,
 organizational_unit_memberships, organization_domains, employee_position_assignments,
 agent_threads, agent_runs, agent_run_steps, agent_events, agent_artifacts, agent_run_leases,
 organization_connector_connections, agent_action_requests, organization_action_policies,
 agent_action_executions, agent_execution_grants
 TO af_tenant;
GRANT DELETE ON organization_action_policies TO af_tenant;
GRANT SELECT, UPDATE ON organizations TO af_tenant;
GRANT SELECT (id, email, display_name, status, created_at) ON users TO af_tenant;
GRANT SELECT (user_id) ON account_password_credentials TO af_tenant;
GRANT SELECT ON catalog_blueprint_versions TO af_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO af_platform;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO af_tenant, af_platform;
`;
