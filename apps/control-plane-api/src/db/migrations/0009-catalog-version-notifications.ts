/**
 * Catalog version notifications (ADR 0029): registering a blueprint version notifies
 * `af_catalog_versions` when it commits, so every API instance loads it without restarting.
 * A statement that inserted nothing (an instance starting with versions already registered)
 * notifies no one. The notification carries no data; versions are read from the table.
 */
export const catalogVersionNotificationsSql = String.raw`
CREATE FUNCTION af_notify_catalog_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inserted) THEN
    PERFORM pg_notify('af_catalog_versions', '');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER catalog_versions_notify
 AFTER INSERT ON catalog_blueprint_versions REFERENCING NEW TABLE AS inserted
 FOR EACH STATEMENT EXECUTE FUNCTION af_notify_catalog_versions();
`;
