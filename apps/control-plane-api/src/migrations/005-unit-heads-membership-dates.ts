/** Preserve existing memberships as open periods while allowing later historical periods. */
export const unitHeadsMembershipDatesSql = `
ALTER TABLE organizational_units ADD COLUMN head_position_id TEXT REFERENCES positions(id);
CREATE UNIQUE INDEX one_unit_per_head_position ON organizational_units(organization_id,head_position_id) WHERE head_position_id IS NOT NULL;
CREATE TRIGGER unit_head_insert BEFORE INSERT ON organizational_units WHEN NEW.head_position_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'INVALID_HEAD_POSITION') WHERE NOT EXISTS (
  SELECT 1 FROM positions WHERE id=NEW.head_position_id AND organization_id=NEW.organization_id
   AND organizational_unit_id=NEW.id AND status='active');
END;
CREATE TRIGGER unit_head_update BEFORE UPDATE OF head_position_id,organization_id ON organizational_units WHEN NEW.head_position_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'INVALID_HEAD_POSITION') WHERE NOT EXISTS (
  SELECT 1 FROM positions WHERE id=NEW.head_position_id AND organization_id=NEW.organization_id
   AND organizational_unit_id=NEW.id AND status='active');
END;
CREATE TRIGGER head_position_move BEFORE UPDATE OF organizational_unit_id,organization_id,status ON positions BEGIN
 SELECT RAISE(ABORT,'HEAD_POSITION_IN_USE') WHERE EXISTS (
  SELECT 1 FROM organizational_units WHERE head_position_id=OLD.id AND organization_id=OLD.organization_id
   AND (NEW.organizational_unit_id<>OLD.organizational_unit_id OR NEW.organization_id<>OLD.organization_id OR NEW.status<>'active'));
END;
DROP TRIGGER units_archive_members;
DROP INDEX one_primary_unit;
CREATE TABLE organizational_unit_memberships_new (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 organizational_unit_id TEXT NOT NULL,
 employee_id TEXT NOT NULL,
 membership_type TEXT NOT NULL CHECK(membership_type IN ('member','lead','manager','owner','contributor')),
 is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
 created_at TEXT NOT NULL,
 created_by TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(organization_id,organizational_unit_id) REFERENCES organizational_units(organization_id,id),
 FOREIGN KEY(organization_id,employee_id) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 CHECK(ended_at IS NULL OR ended_at>=started_at)
);
INSERT INTO organizational_unit_memberships_new
 (id,organization_id,organizational_unit_id,employee_id,membership_type,is_primary,created_at,created_by,started_at)
 SELECT id,organization_id,organizational_unit_id,employee_id,membership_type,is_primary,created_at,created_by,created_at
 FROM organizational_unit_memberships;
DROP TABLE organizational_unit_memberships;
ALTER TABLE organizational_unit_memberships_new RENAME TO organizational_unit_memberships;
CREATE UNIQUE INDEX current_unit_member ON organizational_unit_memberships(organization_id,organizational_unit_id,employee_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX one_primary_unit ON organizational_unit_memberships(organization_id,employee_id) WHERE is_primary=1 AND ended_at IS NULL;
CREATE INDEX unit_membership_history ON organizational_unit_memberships(organization_id,organizational_unit_id,ended_at,started_at);
CREATE TRIGGER units_archive_members BEFORE UPDATE OF status ON organizational_units
WHEN NEW.status='archived' BEGIN
 SELECT RAISE(ABORT,'UNIT_HAS_MEMBERS') WHERE EXISTS (
  SELECT 1 FROM organizational_unit_memberships WHERE organizational_unit_id=OLD.id AND organization_id=OLD.organization_id AND ended_at IS NULL);
END;
`;
