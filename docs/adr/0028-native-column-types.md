# ADR 0028: Native timestamp and JSON column types

- Status: Accepted
- Date: 2026-09-30

## Context

The PostgreSQL baseline (ADR 0018) kept SQLite's column types: timestamps as ISO-8601 text
and JSON as text, some with a check that the text parses. That kept digests and ordering
unchanged during the move, but:

- the database accepted any text as a time, so a malformed value surfaced only when read;
- text ordering matches time ordering only while every value has the same format and a `Z`
  offset;
- JSON validity depended on a check some columns lacked.

Some text must stay byte for byte as written: signed manifests and execution grants, signed
webhook bodies, and catalog content pinned by digest.

## Decision

1. **Timestamps become `timestamptz`.** Migration 0008 converts all 78 ISO-8601 text timestamp
   columns. Only `schema_migrations.applied_at`, which belongs to the migration runner, stays
   text. Times stored without an offset are read as UTC, whatever the server's time zone.
   Expiries already stored as epoch milliseconds (`bigint`) are unchanged.

2. **JSON the API only parses becomes `jsonb`.** 15 columns hold JSON that the API writes with
   `JSON.stringify` and reads with `JSON.parse`: run tasks, step details, event payloads,
   action parameters, change sets and results, connector settings, installation configuration,
   audit metadata, change-event snapshots, provisioning requests, batch results, login
   transactions and failed quality gates. Their `af_json_valid` checks are dropped, because the
   type now does that job.

3. **Signed and pinned text stays `text`:** `agent_manifests.body`,
   `agent_execution_grants.signed_grant`, `alert_webhook_deliveries.body` and
   `catalog_blueprint_versions.content`. `messages.content` is not JSON.

4. **The API sees the same values.** The driver returns `timestamptz` as ISO-8601 UTC strings
   with milliseconds, exactly as the API writes them, and `jsonb` as JSON text. Contracts and
   responses do not change. A timestamp JavaScript cannot represent, such as `infinity`, fails
   the read. The organization defaults trigger fills times to the millisecond, so a value read
   back compares equal to the stored one.

5. **One transaction, or nothing.** Each table is altered in one statement, so checks
   comparing two of its timestamps hold throughout. Five identity triggers that name converted
   columns are dropped and recreated unchanged, along with one column default. A stored value
   that is not a valid timestamp or JSON fails the migration, and the database stays at
   release 7.

## Consequences

- The database rejects malformed times and JSON on write. Tests that wrote placeholder text
  into timestamp columns now use real times.
- Ordering and comparisons in SQL are by time, not by string.
- `jsonb` does not keep key order or whitespace. Nothing reads either, since hashes are
  compared with fresh requests, not recomputed from stored JSON.
- SQL that passes a timestamp in a text-typed position must cast it to `timestamptz`.
- The upgrade rewrites every converted table under the migration's lock. Large deployments
  should plan for that downtime.
