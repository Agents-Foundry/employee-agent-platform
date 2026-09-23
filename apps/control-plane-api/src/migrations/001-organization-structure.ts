/** Additive upgrade: existing tenants, employees and signed manifests keep their IDs. */
export const organizationStructureSql = `
CREATE UNIQUE INDEX employees_tenant_id ON employees(organization_id, id);
CREATE TABLE organizational_units (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  parent_id TEXT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
  unit_type TEXT NOT NULL CHECK(unit_type IN ('business_unit','division','department','sub_department','team','squad','pod','chapter','guild','other')),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE(organization_id,id),
  UNIQUE(organization_id,code),
  FOREIGN KEY(organization_id,parent_id) REFERENCES organizational_units(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
  FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id),
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX units_parent ON organizational_units(organization_id,parent_id,status);
CREATE INDEX units_name ON organizational_units(organization_id,status,name,id);
CREATE TRIGGER units_no_cycle BEFORE UPDATE OF parent_id ON organizational_units
WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'HIERARCHY_CYCLE') WHERE NEW.parent_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT OLD.id UNION SELECT u.id FROM organizational_units u JOIN descendants d ON u.parent_id=d.id
      WHERE u.organization_id=OLD.organization_id
    ) SELECT id FROM descendants
  );
END;
CREATE TRIGGER units_active_parent_insert BEFORE INSERT ON organizational_units
WHEN NEW.parent_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'PARENT_INACTIVE') WHERE NOT EXISTS (
   SELECT 1 FROM organizational_units WHERE id=NEW.parent_id AND organization_id=NEW.organization_id AND status='active'
 );
END;
CREATE TRIGGER units_active_parent_update BEFORE UPDATE ON organizational_units
WHEN NEW.status='active' AND NEW.parent_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'PARENT_INACTIVE') WHERE NOT EXISTS (
   SELECT 1 FROM organizational_units WHERE id=NEW.parent_id AND organization_id=NEW.organization_id AND status='active'
 );
END;
CREATE TRIGGER units_archive_children BEFORE UPDATE OF status ON organizational_units
WHEN NEW.status='archived' BEGIN
 SELECT RAISE(ABORT,'UNIT_HAS_CHILDREN') WHERE EXISTS (
   SELECT 1 FROM organizational_units WHERE parent_id=OLD.id AND organization_id=OLD.organization_id AND status='active'
 );
END;
CREATE TABLE organizational_unit_memberships (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 organizational_unit_id TEXT NOT NULL,
 employee_id TEXT NOT NULL,
 membership_type TEXT NOT NULL CHECK(membership_type IN ('member','lead','manager','owner','contributor')),
 is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
 created_at TEXT NOT NULL,
 created_by TEXT NOT NULL,
 UNIQUE(organization_id,organizational_unit_id,employee_id),
 FOREIGN KEY(organization_id,organizational_unit_id) REFERENCES organizational_units(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id)
);
CREATE UNIQUE INDEX one_primary_unit ON organizational_unit_memberships(organization_id,employee_id) WHERE is_primary=1;
CREATE TRIGGER units_archive_members BEFORE UPDATE OF status ON organizational_units
WHEN NEW.status='archived' BEGIN
 SELECT RAISE(ABORT,'UNIT_HAS_MEMBERS') WHERE EXISTS (
   SELECT 1 FROM organizational_unit_memberships WHERE organizational_unit_id=OLD.id AND organization_id=OLD.organization_id
 );
END;
CREATE TABLE organization_change_events (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 resource_type TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 before_json TEXT,
 after_json TEXT,
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(organization_id,actor_id) REFERENCES employees(organization_id,id)
);
CREATE INDEX organization_changes_time ON organization_change_events(organization_id,created_at,id);
CREATE TRIGGER organization_changes_no_update BEFORE UPDATE ON organization_change_events BEGIN
 SELECT RAISE(ABORT,'AUDIT_IMMUTABLE');
END;
CREATE TRIGGER organization_changes_no_delete BEFORE DELETE ON organization_change_events BEGIN
 SELECT RAISE(ABORT,'AUDIT_IMMUTABLE');
END;
`;
