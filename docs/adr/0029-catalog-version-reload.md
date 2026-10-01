# ADR 0029: Loading catalog versions registered by other instances

- Status: Accepted
- Date: 2026-10-01

## Context

Each API instance registers the catalog versions it ships at startup, then serves the catalog
of record from memory ([ADR 0010](0010-catalog-of-record.md)). During a rolling
upgrade, an instance of the new release registers a version that instances still running know
nothing about. Until they restart:

- creating an installation or agent for that version fails with `BLUEPRINT_VERSION_UNKNOWN`;
- governed actions and run submissions for agents pinned to it are refused;
- listings omit it.

Failing closed is safe, but it breaks work for no reason. Registered versions are immutable
and are never deleted, so a version this instance has loaded can never become wrong. The only
thing that can be stale is the set of versions it knows.

## Decision

1. **The database announces registrations.** Migration 0009 adds a statement-level trigger on
   `catalog_blueprint_versions` that notifies `af_catalog_versions` when a statement inserts at
   least one row. An instance starting with every version already registered notifies no one.
   The notification carries no data.

2. **Each instance loads new versions when notified.** It listens on its own platform
   connection, as for tenant domains ([ADR 0027](0027-tenant-domain-cache.md)), and reads the
   table again on each notification and each time it starts listening. Loads are coalesced:
   a notification during a load triggers one more load. The listen-and-retry logic is shared
   with the tenant domain cache (`ChangeListener`).

3. **Resolving never depends on the notification.** A version that is not in memory is read
   from the database, in the caller's transaction when there is one. It is then known. A
   version that is not in the table still fails with `BLUEPRINT_VERSION_UNKNOWN`.

4. **Listings reload when they could be stale:** while the instance is not listening, or after
   a load failed. Otherwise they are served from memory.

5. **Only verifiable versions are served.** A stored version is used only if its content still
   hashes to its digest, names the blueprint and version it is stored as, and declares only
   actions this release's policy engine knows. Otherwise it is left out of listings, and
   resolving it fails with `BLUEPRINT_VERSION_UNSUPPORTED` (409). This applies at startup too.
   Capabilities are still derived from the current policy engine, never from catalog data.

6. **Catalog lookups are asynchronous.** `bundle`, `summaries`, `legacyBlueprints` and the
   pinned-workflow lookup used by the runtime return promises.

## Consequences

- A version registered by one instance can be used on every instance at once, and is listed
  as soon as its notification arrives, normally within milliseconds of the commit.
- An older release running alongside a newer one serves the newer versions it can verify. One
  that declares an action the older release does not know is refused until that instance is
  upgraded, so governance never depends on a policy decision the instance cannot make.
- Each instance holds one more database connection, in addition to the tenant domain
  listener.
- Requests for versions that do not exist reach the database each time. They require
  authentication and read one row by primary key.
- Content is not checked against the catalog schemas when loaded, because older versions
  were registered under older schemas. It is checked against its digest instead, which was
  computed from content validated by the release that registered it.
