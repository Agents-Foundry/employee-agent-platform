/** Rebuild the legacy employee table to make work email tenant-scoped. */
export const accountLinkingSql = `
CREATE TABLE employees_new (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 email TEXT NOT NULL,
 role TEXT NOT NULL,
 team TEXT NOT NULL,
 user_id TEXT REFERENCES users(id),
 employee_number TEXT,
 employment_type TEXT NOT NULL DEFAULT 'employee' CHECK(employment_type IN ('employee','contractor','external')),
 employment_status TEXT NOT NULL DEFAULT 'active' CHECK(employment_status IN ('active','inactive')),
 version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(organization_id) REFERENCES organizations(id)
);
INSERT INTO employees_new SELECT id,organization_id,display_name,email,role,team,user_id,employee_number,employment_type,employment_status,version FROM employees;
DROP TRIGGER identity_user_insert;
DROP TRIGGER identity_user_update;
DROP TRIGGER assignment_active_dependencies;
DROP TABLE employees;
ALTER TABLE employees_new RENAME TO employees;
CREATE UNIQUE INDEX employees_tenant_id ON employees(organization_id,id);
CREATE UNIQUE INDEX employee_email_per_tenant ON employees(organization_id,email COLLATE NOCASE);
CREATE UNIQUE INDEX employee_user_per_tenant ON employees(organization_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX employee_number_per_tenant ON employees(organization_id,employee_number) WHERE employee_number IS NOT NULL;
CREATE UNIQUE INDEX employee_user_tenant_link ON employees(organization_id,id,user_id);
CREATE TRIGGER identity_user_insert BEFORE INSERT ON identities BEGIN
 SELECT RAISE(ABORT,'IDENTITY_USER_MISMATCH') WHERE NEW.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND user_id=NEW.user_id);
END;
CREATE TRIGGER identity_user_update BEFORE UPDATE OF user_id,employee_id ON identities BEGIN
 SELECT RAISE(ABORT,'IDENTITY_USER_MISMATCH') WHERE NEW.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM employees WHERE id=NEW.employee_id AND user_id=NEW.user_id);
END;
CREATE TRIGGER assignment_active_dependencies BEFORE INSERT ON employee_position_assignments BEGIN
 SELECT RAISE(ABORT,'ASSIGNMENT_INACTIVE') WHERE NOT EXISTS(SELECT 1 FROM employees WHERE organization_id=NEW.organization_id AND id=NEW.employee_id AND employment_status='active')
 OR NOT EXISTS(SELECT 1 FROM positions WHERE organization_id=NEW.organization_id AND id=NEW.position_id AND status='active');
END;

CREATE TABLE account_password_credentials (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 hash TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
INSERT INTO account_password_credentials(user_id,hash,updated_at)
 SELECT i.user_id,p.hash,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM password_credentials p
 JOIN identities i ON i.issuer=p.issuer AND i.subject=p.subject
 WHERE p.issuer='urn:agents-foundry:password';

ALTER TABLE auth_sessions ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE auth_sessions ADD COLUMN organization_id TEXT REFERENCES organizations(id);
UPDATE auth_sessions SET user_id=(SELECT i.user_id FROM identities i WHERE i.issuer=auth_sessions.issuer AND i.subject=auth_sessions.subject),
 organization_id=(SELECT e.organization_id FROM identities i JOIN employees e ON e.id=i.employee_id WHERE i.issuer=auth_sessions.issuer AND i.subject=auth_sessions.subject);
CREATE INDEX account_sessions_by_user ON auth_sessions(user_id,organization_id);

CREATE TABLE account_link_invitations (
 hash TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 employee_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 expires_at INTEGER NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 invited_by TEXT,
 FOREIGN KEY(organization_id,employee_id,user_id) REFERENCES employees(organization_id,id,user_id),
 FOREIGN KEY(organization_id,invited_by) REFERENCES employees(organization_id,id)
);
CREATE INDEX account_link_pending ON account_link_invitations(organization_id,employee_id,consumed);
`;
