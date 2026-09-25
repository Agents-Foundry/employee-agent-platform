/**
 * Agent catalog and organization installations (Architecture V2 Phase B). Additive: existing
 * agents keep their rows; their installation link stays NULL.
 */
export const agentCatalogSql = `
CREATE TABLE catalog_blueprint_versions (
 blueprint_id TEXT NOT NULL,
 version TEXT NOT NULL,
 digest TEXT NOT NULL CHECK(length(digest)=64),
 content TEXT NOT NULL CHECK(json_valid(content)),
 registered_at TEXT NOT NULL,
 PRIMARY KEY(blueprint_id,version)
);
CREATE TRIGGER catalog_versions_no_update BEFORE UPDATE ON catalog_blueprint_versions BEGIN
 SELECT RAISE(ABORT,'CATALOG_VERSION_IMMUTABLE');
END;
CREATE TRIGGER catalog_versions_no_delete BEFORE DELETE ON catalog_blueprint_versions BEGIN
 SELECT RAISE(ABORT,'CATALOG_VERSION_IMMUTABLE');
END;

CREATE TABLE organization_agent_installations (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 blueprint_id TEXT NOT NULL,
 blueprint_version TEXT NOT NULL,
 configuration TEXT NOT NULL CHECK(json_valid(configuration)),
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','RETIRED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(blueprint_id,blueprint_version) REFERENCES catalog_blueprint_versions(blueprint_id,version),
 FOREIGN KEY(organization_id,created_by) REFERENCES employees(organization_id,id),
 FOREIGN KEY(organization_id,updated_by) REFERENCES employees(organization_id,id)
);
CREATE UNIQUE INDEX installation_active_name ON organization_agent_installations(organization_id,name COLLATE NOCASE)
 WHERE status='ACTIVE';
CREATE TRIGGER installation_identity_immutable BEFORE UPDATE OF id,organization_id,blueprint_id,created_by,created_at
 ON organization_agent_installations BEGIN SELECT RAISE(ABORT,'INSTALLATION_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER installation_retired_final BEFORE UPDATE ON organization_agent_installations
 WHEN OLD.status='RETIRED' BEGIN SELECT RAISE(ABORT,'INSTALLATION_RETIRED'); END;
CREATE TRIGGER installation_no_delete BEFORE DELETE ON organization_agent_installations BEGIN
 SELECT RAISE(ABORT,'INSTALLATION_HISTORY_RETAINED');
END;

ALTER TABLE agents ADD COLUMN installation_id TEXT;
CREATE INDEX agents_installation ON agents(organization_id,installation_id) WHERE installation_id IS NOT NULL;
CREATE TRIGGER agents_installation_scope BEFORE INSERT ON agents WHEN NEW.installation_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'INSTALLATION_SCOPE_MISMATCH') WHERE NOT EXISTS (
  SELECT 1 FROM organization_agent_installations WHERE id=NEW.installation_id
   AND organization_id=NEW.organization_id AND status='ACTIVE');
END;
CREATE TRIGGER agents_installation_immutable BEFORE UPDATE OF installation_id ON agents BEGIN
 SELECT RAISE(ABORT,'AGENT_INSTALLATION_IMMUTABLE');
END;
`;
