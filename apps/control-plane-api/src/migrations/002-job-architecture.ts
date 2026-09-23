const common = `
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
 code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 40),
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)`;
export const jobArchitectureSql = `
CREATE TABLE job_families (${common});
CREATE TABLE job_disciplines (job_family_id TEXT NOT NULL, ${common},
 FOREIGN KEY(organization_id,job_family_id) REFERENCES job_families(organization_id,id));
CREATE TABLE roles (job_family_id TEXT NOT NULL, discipline_id TEXT NOT NULL, ${common},
 FOREIGN KEY(organization_id,job_family_id) REFERENCES job_families(organization_id,id),
 FOREIGN KEY(organization_id,discipline_id) REFERENCES job_disciplines(organization_id,id));
CREATE TABLE job_levels (rank INTEGER NOT NULL CHECK(rank>=0), ${common});
CREATE TABLE positions (organizational_unit_id TEXT NOT NULL,role_id TEXT NOT NULL,job_level_id TEXT NOT NULL,reports_to_position_id TEXT, ${common},
 FOREIGN KEY(organization_id,organizational_unit_id) REFERENCES organizational_units(organization_id,id),
 FOREIGN KEY(organization_id,role_id) REFERENCES roles(organization_id,id),
 FOREIGN KEY(organization_id,job_level_id) REFERENCES job_levels(organization_id,id),
 FOREIGN KEY(organization_id,reports_to_position_id) REFERENCES positions(organization_id,id),
 CHECK(reports_to_position_id IS NULL OR reports_to_position_id<>id));
CREATE INDEX positions_unit ON positions(organization_id,organizational_unit_id,status);
CREATE INDEX positions_role ON positions(organization_id,role_id,status);
CREATE INDEX disciplines_family ON job_disciplines(organization_id,job_family_id,status);
CREATE INDEX roles_discipline ON roles(organization_id,discipline_id,status);
CREATE TRIGGER position_no_cycle BEFORE UPDATE OF reports_to_position_id ON positions
WHEN NEW.reports_to_position_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'HIERARCHY_CYCLE') WHERE NEW.reports_to_position_id IN (
   WITH RECURSIVE descendants(id) AS (
     SELECT OLD.id UNION SELECT p.id FROM positions p JOIN descendants d ON p.reports_to_position_id=d.id WHERE p.organization_id=OLD.organization_id
   ) SELECT id FROM descendants);
END;
CREATE TRIGGER unit_archive_positions BEFORE UPDATE OF status ON organizational_units
WHEN NEW.status='archived' BEGIN
 SELECT RAISE(ABORT,'UNIT_HAS_CHILDREN') WHERE EXISTS (
   SELECT 1 FROM positions WHERE organization_id=OLD.organization_id AND organizational_unit_id=OLD.id AND status='active');
END;
${['INSERT', 'UPDATE']
  .map(
    (event) => `
CREATE TRIGGER role_family_${event.toLowerCase()} BEFORE ${event} ON roles BEGIN
 SELECT RAISE(ABORT,'JOB_FAMILY_MISMATCH') WHERE NOT EXISTS (
   SELECT 1 FROM job_disciplines WHERE organization_id=NEW.organization_id AND id=NEW.discipline_id AND job_family_id=NEW.job_family_id);
END;`,
  )
  .join('')}
CREATE TRIGGER discipline_family_update BEFORE UPDATE OF job_family_id ON job_disciplines BEGIN
 SELECT RAISE(ABORT,'JOB_FAMILY_MISMATCH') WHERE EXISTS (
   SELECT 1 FROM roles WHERE organization_id=OLD.organization_id AND discipline_id=OLD.id AND job_family_id<>NEW.job_family_id);
END;
`;
