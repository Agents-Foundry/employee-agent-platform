/**
 * Catalog bundle schema (ADR 0030): each registered version records the bundle structure it
 * was written in. Every version registered so far, including those imported from SQLite, is
 * `agents-foundry.catalog-bundle/v1`. A release serves only the schemas it implements, so an
 * older instance refuses a bundle written in a newer structure instead of misreading it.
 * Adding a column with a default does not fire the immutability triggers.
 */
export const catalogBundleSchemaSql = String.raw`
ALTER TABLE catalog_blueprint_versions
 ADD COLUMN bundle_schema text NOT NULL DEFAULT 'agents-foundry.catalog-bundle/v1'
 CHECK (bundle_schema ~ '^[a-z0-9.-]{1,100}/v[0-9]{1,6}$');
`;
