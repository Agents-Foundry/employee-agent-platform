# ADR 0027: Remembering verified tenant domains

- Status: Accepted
- Date: 2026-09-30

## Context

Every request resolves its host to an organization when the host is a verified custom domain.
The host check, CORS and the sign-in origin check each looked the host up in the database, so
one request could cost three platform transactions. Every request with an unrecognized host
also reached the database before being refused.

Resolutions change rarely: a domain is verified or disabled, or an organization is suspended.
Suspensions are made by operators, sometimes directly in the database. A suspended
organization's domain must stop resolving at once, on every API instance.

## Decision

1. **Each instance remembers resolutions.** `TenantDomainCache` maps a normalized host to its
   organization, or to none.
   - Organizations are reused for 60 seconds, unrecognized hosts for 30 seconds.
   - At most 10,000 hosts are kept; the least recently used go first.
   - Concurrent requests for one host share a single lookup.
   - Lookup errors are never remembered, so a database failure still fails the request.
   - Hosts that are not valid domain names never reach the cache or the database.

2. **The database announces changes.** Migration 0007 adds statement-level triggers on
   `organization_domains` (insert, update, delete, truncate) and `organizations` (update,
   delete, truncate). They notify the `af_tenant_domains` channel, which PostgreSQL delivers
   only when the change commits, to every listening connection, whoever made the change. The
   notification carries no data; each instance forgets everything it remembers. A lookup that
   was running when a notification arrived is not remembered.

3. **No listener, no cache.** Each instance listens on its own platform connection, outside
   the pools. Answers are used only while it is connected. When it fails, the instance forgets
   everything, sends every lookup to the database, and listens again every 5 seconds. TCP
   keepalive detects dead connections.

4. **Verifying a domain also clears this instance at once,** so the admin who verified it is
   not refused while the notification is on its way.

## Consequences

- A host costs one database lookup per instance per minute instead of up to three per request,
  and floods of unknown hosts are answered from memory.
- A change is seen as soon as its notification arrives, normally within milliseconds of the
  commit. The expiry bounds the delay to 60 seconds if notifications stopped arriving while the
  connection still looked healthy.
- Each instance holds one more database connection.
- Resolution is still per instance; there is no shared cache service to operate.
