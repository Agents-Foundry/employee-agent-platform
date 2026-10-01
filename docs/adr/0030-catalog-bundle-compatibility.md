# ADR 0030: Catalog bundle compatibility

- Status: Accepted
- Date: 2026-10-01

## Context

Since [ADR 0029](0029-catalog-version-reload.md), an instance serves catalog versions that
another release registered. It checked the stored content's digest, its blueprint id and
version, and that its actions were known to its policy engine, but not its structure. A newer
release could add a field to a blueprint, tool or workflow. An older instance would then load
the bundle and silently ignore the new field, even if the field restricts what the role may
do. The digest proves only that content is unchanged since registration, not that this
release understands it.

## Decision

1. **Bundles name their structure.** Migration 0010 adds `bundle_schema` to
   `catalog_blueprint_versions`. Every version registered so far, including those imported
   from SQLite, is `agents-foundry.catalog-bundle/v1`, and this release registers new versions
   with that identifier. A release that changes the bundle structure in a way older releases
   cannot interpret must use a new identifier.

2. **Every stored bundle is fully validated before it is served,** at startup, on reload and
   when looked up (`storedBundleProblems`). It must:
   - declare a bundle schema this release implements;
   - pass the current strict schemas for the blueprint, skills, tools and workflows, so an
     unknown field is refused rather than ignored, and a field of the wrong shape is refused;
   - be the blueprint id and version it is stored as;
   - still match its digest;
   - contain exactly the skills, tools and workflows its blueprint pins, in order;
   - pass the same consistency rules as shipped definitions, with every action known to the
     current policy engine.

   Anything else is left out of listings, and resolving it fails with
   `BLUEPRINT_VERSION_UNSUPPORTED` (409). A shipped version that fails is a startup error
   (`CATALOG_VERSION_MUTATED`).

3. Capabilities are still derived from the current policy engine, never from catalog data.

## Consequences

- An older instance never serves a bundle it cannot fully interpret. It refuses the version
  until it is upgraded.
- Versions registered by an older release are still served, because the current schemas
  accept every released bundle. If a future schema change would refuse an existing version,
  that change needs a new bundle schema and a migration path, not a silent drop.
- The identifier column is written only by the platform role during registration. It is not
  covered by the digest; a wrong label cannot make content pass, because the content is
  validated against the strict schemas either way.
- Evaluation suites remain outside bundles and are validated only for shipped definitions.
