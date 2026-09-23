const uuid = `(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))))`;
export const profilesIdentitiesSql = `
ALTER TABLE organizations ADD COLUMN legal_name TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN code TEXT;
UPDATE organizations SET code=upper(slug);
CREATE UNIQUE INDEX organization_code_unique ON organizations(code COLLATE NOCASE);
ALTER TABLE organizations ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN industry TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE organizations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE organizations ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','disabled'));
ALTER TABLE organizations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE organizations ADD COLUMN created_at TEXT;
ALTER TABLE organizations ADD COLUMN updated_at TEXT;
ALTER TABLE organizations ADD COLUMN updated_by TEXT;
UPDATE organizations SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
CREATE TRIGGER organization_profile_defaults AFTER INSERT ON organizations BEGIN
 UPDATE organizations SET code=coalesce(NEW.code,upper(NEW.slug)),created_at=coalesce(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=coalesce(NEW.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=NEW.id;
END;

-- Users are global authentication principals. Employment and access are tenant-owned.
CREATE TABLE users (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 display_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at TEXT NOT NULL
);
ALTER TABLE employees ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE employees ADD COLUMN employee_number TEXT;
ALTER TABLE employees ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'employee' CHECK(employment_type IN ('employee','contractor','external'));
ALTER TABLE employees ADD COLUMN employment_status TEXT NOT NULL DEFAULT 'active' CHECK(employment_status IN ('active','inactive'));
ALTER TABLE employees ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX employee_user_per_tenant ON employees(organization_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX employee_number_per_tenant ON employees(organization_id,employee_number) WHERE employee_number IS NOT NULL;
CREATE UNIQUE INDEX employee_user_tenant_link ON employees(organization_id,id,user_id);
INSERT INTO users(id,email,display_name,created_at)
 SELECT ${uuid},e.email,e.display_name,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM employees e
 WHERE EXISTS(SELECT 1 FROM identities i WHERE i.employee_id=e.id);
UPDATE employees SET user_id=(SELECT u.id FROM users u WHERE u.email=employees.email COLLATE NOCASE);
ALTER TABLE identities ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE identities SET user_id=(SELECT e.user_id FROM employees e WHERE e.id=identities.employee_id);
CREATE TABLE organization_memberships (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 employee_id TEXT NOT NULL,
 security_role TEXT NOT NULL CHECK(security_role IN ('ADMIN','EMPLOYEE')),
 membership_status TEXT NOT NULL CHECK(membership_status IN ('pending','active','suspended')),
 version INTEGER NOT NULL DEFAULT 1,
 joined_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 invited_by TEXT,
 UNIQUE(organization_id,user_id), UNIQUE(organization_id,employee_id),
 FOREIGN KEY(organization_id,employee_id,user_id) REFERENCES employees(organization_id,id,user_id)
);
INSERT INTO organization_memberships(id,organization_id,user_id,employee_id,security_role,membership_status,joined_at,updated_at)
 SELECT ${uuid},e.organization_id,e.user_id,e.id,e.role,
 CASE WHEN EXISTS(SELECT 1 FROM identities i WHERE i.employee_id=e.id AND i.enabled=1) THEN 'active'
 WHEN EXISTS(SELECT 1 FROM invitations v WHERE v.employee_id=e.id AND v.consumed=0) THEN 'pending' ELSE 'suspended' END,
 strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM employees e WHERE e.user_id IS NOT NULL;
CREATE INDEX memberships_user_status ON organization_memberships(user_id,membership_status);
CREATE TRIGGER identity_user_insert BEFORE INSERT ON identities BEGIN
 SELECT RAISE(ABORT,'IDENTITY_USER_MISMATCH') WHERE NEW.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND user_id=NEW.user_id);
END;
CREATE TRIGGER identity_user_update BEFORE UPDATE OF user_id,employee_id ON identities BEGIN
 SELECT RAISE(ABORT,'IDENTITY_USER_MISMATCH') WHERE NEW.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND user_id=NEW.user_id);
END;

CREATE TABLE organization_domains (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
 domain_type TEXT NOT NULL CHECK(domain_type IN ('custom_domain','platform_subdomain','internal')),
 is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
 verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified','disabled')),
 verification_token TEXT NOT NULL,
 verified_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 CHECK(is_primary=0 OR verification_status='verified')
);
CREATE UNIQUE INDEX primary_domain_per_tenant ON organization_domains(organization_id) WHERE is_primary=1;
CREATE INDEX domain_tenant ON organization_domains(organization_id,verification_status);

CREATE TABLE employee_position_assignments (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 employee_id TEXT NOT NULL,
 position_id TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT,
 created_by TEXT NOT NULL,
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,position_id) REFERENCES positions(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id)
);
CREATE UNIQUE INDEX employee_current_position ON employee_position_assignments(organization_id,employee_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX position_current_occupant ON employee_position_assignments(organization_id,position_id) WHERE ended_at IS NULL;
CREATE TRIGGER occupied_position_archive BEFORE UPDATE OF status ON positions WHEN NEW.status='archived' BEGIN
 SELECT RAISE(ABORT,'POSITION_OCCUPIED') WHERE EXISTS(SELECT 1 FROM employee_position_assignments WHERE organization_id=OLD.organization_id AND position_id=OLD.id AND ended_at IS NULL);
END;
CREATE TRIGGER assignment_active_dependencies BEFORE INSERT ON employee_position_assignments BEGIN
 SELECT RAISE(ABORT,'ASSIGNMENT_INACTIVE') WHERE NOT EXISTS(SELECT 1 FROM employees WHERE organization_id=NEW.organization_id AND id=NEW.employee_id AND employment_status='active')
 OR NOT EXISTS(SELECT 1 FROM positions WHERE organization_id=NEW.organization_id AND id=NEW.position_id AND status='active');
END;
`;
