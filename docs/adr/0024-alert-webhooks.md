# ADR 0024: Alert webhooks

- Status: Accepted
- Date: 2026-09-30

## Context

Model budget alerts (ADR 0023) appear only in the admin console and the audit log, so an
administrator learns of one only by looking. Organizations want alerts where they already
work: an on-call tool, a chat channel or their own automation.

Sending them means the control plane makes outbound requests to URLs an organization
chooses. That is a server-side request forgery risk: a URL could point at the control plane's
own network, its cloud metadata service or another tenant's systems. Webhook URLs also often
carry tokens in their path or query, and raw secrets must not reach the UI, logs or audit.

## Decision

1. **Endpoints.** Organization admins register up to ten endpoints, each with a description.
   - An endpoint is HTTPS on the default port, to a public host name. IP literals, `localhost`,
     single-label names, internal suffixes, user info and fragments are refused.
   - The URL never changes once set; to move, add a new endpoint and disable the old one.
     Endpoints are disabled and enabled, never deleted.
   - The full URL is returned only as `displayUrl`: the origin and the last four characters
     of the rest. Change events record the same. The full URL is stored only in the database.

2. **Signed deliveries, no shared secret.** Each request is signed with the control plane's
   Ed25519 key, over a domain-separated input like execution grants (ADR 0013):
   `agents-foundry/webhook/v1\n<delivery id>\n<unix seconds>\n<body>`.
   - The headers are `af-webhook-id`, `af-webhook-timestamp`, `af-webhook-key-id` and
     `af-webhook-signature` (`ed25519=<base64>`).
   - Receivers pin the public key, which the admin console shows. They verify the signature
     and reject old timestamps.
   - Because there is no per-endpoint secret, none has to be stored, shown or rotated.

3. **Transactional outbox.** A delivery is queued in the same transaction that raises its
   alert, one per active endpoint, so an alert is never raised without its deliveries.
   - The body is fixed when the delivery is queued, and every retry sends identical bytes.
   - Admins can queue a `webhook.test` delivery to an active endpoint.

4. **Dispatcher.** The API process sends due deliveries every 15 seconds, across
   organizations, in the platform scope.
   - A claim leases a delivery for two minutes (`FOR UPDATE SKIP LOCKED`), so several API
     processes never send the same attempt at once, and a crash only delays it.
   - Delivery is at least once: a crash after sending but before recording repeats the
     delivery, and receivers drop repeats by delivery id.
   - 2xx is delivered.
   - Timeouts, connection failures, 408, 429 and 5xx are retried after 1 minute, 5 minutes,
     30 minutes, 2 hours and 6 hours.
   - The delivery fails after six attempts, and immediately on a blocked address, a redirect
     or any other response. A failure is audited as `alert.webhook.failed`.
   - Deliveries to a disabled endpoint wait until it is enabled again.

5. **Outbound network controls.**
   - Every address a host name resolves to is checked at connect time, through the socket's
     own lookup. A name that resolves to a private, loopback, link-local, shared, reserved,
     documentation, multicast or translated (NAT64, 6to4) address is refused. This also stops
     a name that resolves differently later (DNS rebinding). Address literals are checked
     directly.
   - Requests have a 10-second deadline, never follow redirects, use no connection pooling,
     and never read the response body. Only the status code is kept.
   - Failures are recorded as stable codes, such as `WEBHOOK_TIMEOUT` or `WEBHOOK_HTTP_503`,
     never raw error messages.

6. **Off by default.** `ALERT_WEBHOOKS_ENABLED=true` turns on the routes, queueing and the
   dispatcher. Without it, the routes return 404 and nothing is queued or sent.

7. **Immutability and isolation.**
   - Both tables have row-level security.
   - The tenant role may insert deliveries but never update them; only the dispatcher,
     through the platform role, records progress.
   - Triggers keep an endpoint's URL, and a delivery's identity and body, unchanged. They
     keep a finished delivery final and forbid deletes.

## Consequences

- An operator who turns delivery on lets the control plane make HTTPS requests to
  organization-chosen public hosts. Deployments that must restrict egress further should
  also route the API through an egress proxy with an allow-list.
- The signing key is shared with manifests and execution grants, under domain separation.
  Rotating it changes what receivers must pin.
- Endpoints can't be edited or removed, only disabled. The history of where alerts went is
  kept.
- Only budget alerts and test deliveries are sent. Other event types, email and chat
  integrations are separate work.
