# Pilot runbook

For the operators and organization administrators of a controlled QA, Frontend or Backend
pilot. Every alert in `operations/` links to a section here. Background:
[ADR 0039](adr/0039-pilot-operations.md), [observability](observability.md),
[failure handling](failure-handling.md), [pilot readiness](pilot-readiness.md).

Never paste a secret, token, password or connector payload into a ticket, chat or this
runbook's evidence. The commands below print none.

## Validating a deployment

Set up the environment first with the [pilot environment setup checklist](pilot-environment-setup.md).

After every deployment, before anyone uses it:

```bash
# On the control-plane host, with its environment:
npm run pilot:validate -- --scope control-plane --out ./reports/validate-control-plane.json
# On each execution-runtime host, with its environment:
npm run pilot:validate -- --scope execution-host --out ./reports/validate-execution.json
```

Both read only: database statements run in read-only transactions, the object-store probe
writes under `pilot-validate/` and removes it, and the egress proxy probe container is removed.
The pilot environment must also set `PILOT_ORGANIZATION_ID`, `PILOT_MODEL_PROVIDER`, the
health-check secret `pilot-healthcheck` in the pilot organization's Vault path (or
`PILOT_HEALTHCHECK_SECRET`), and `PILOT_RELEASE_COMMIT` (the deployed commit).

Then run the **Pilot smoke** workflow (Actions → Pilot smoke → Run workflow). It runs one QA
run end to end against the dedicated test organization, project and repository, and needs a
reviewer's approval of the `pilot` environment. Download its `pilot-smoke-report`.

Put the three reports in `.readiness/operational/` of a checkout of the deployed commit and
run `npm run readiness`. **Start the pilot only if it prints "Ready for a controlled pilot".**
A failed check names what is wrong (a variable, a role, an image); fix it and validate again.

## Starting and stopping runtimes

| Process           | Start                                                     | Stop                                                                     |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Control plane     | `npm start --workspace @agents-foundry/control-plane-api` | `SIGTERM`: stops accepting requests, flushes telemetry                   |
| Agent runtime     | `npm start --workspace @agents-foundry/agent-runtime`     | `SIGTERM`: takes no new run, waits for its runs to pause or end          |
| Execution runtime | `npm start --workspace @agents-foundry/execution-runtime` | `SIGTERM`: finishes the request in hand; restart closes interrupted ones |

- Stop agent runtimes with `SIGTERM`, never `SIGKILL`, unless they hang. A killed runtime's
  runs are continued by another runtime once their lease expires (up to ten minutes).
- Run at least two agent runtimes serving the pilot organization, so one can be restarted.
- An execution runtime restarted mid-operation closes that operation as
  `OPERATION_INTERRUPTED` and discards checkouts; the agent sees a failed tool, not a repeat.
- `EGRESS_PROXY_UNAVAILABLE` or `SANDBOX_IMAGE_UNAVAILABLE` (alerts `egress-unavailable`,
  `sandbox-startup-slow`): check `docker info` on the execution host, that the images in
  `EXECUTION_SANDBOX_IMAGE` and `EXECUTION_PLAYWRIGHT_IMAGE` are present (they are never
  pulled), then `npm run pilot:validate -- --scope execution-host`.

## Reading the dashboards

Import `operations/grafana-dashboard.json`, or build the panels from `operations.json`.

| Section      | Healthy                                                   | Look at                                                                     |
| ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Runs         | Completion rate above 80%; queue near zero                | Failed runs by `reason`; a growing queue means no runtime is taking runs    |
| Recovery     | Expired leases 0; abandoned 0                             | A runtime is gone; see [recovering a stuck run](#recovering-a-stuck-run)    |
| Governance   | Writes to reconcile 0; approval wait as agreed with users | Any write to reconcile needs an administrator now                           |
| Models       | Latency stable; no budget denials                         | Denials by limit; failures by provider and code                             |
| Dependencies | All zero                                                  | Which dependency: connector, Vault, object store, credential leases, DB     |
| Execution    | Failures and denials rare                                 | Egress unavailable; sandbox start-up; integrity failures; dropped telemetry |

To follow one run, search the tracing backend for `af.run.id=<run id>`; the run's actions are
at `GET /api/execution/v1/runs/<run id>/actions`.

## Handling writes to reconcile

Alert `reconciliation-required`. A Jira or GitHub write did not confirm, so it may or may not
have happened. The platform refuses the same action in that conversation, and the same request
anywhere in the organization, until an administrator records the outcome.

1. Open the admin app, **Writes to reconcile**. Each entry shows the action, its target, the
   request summary, the run and conversation, the time and why the outcome is unknown.
2. Look in the external system (the Jira project, the repository) for exactly that change.
3. Choose **Verified applied** if it is there, **Verified not applied** if it is not. Confirm
   that you checked, optionally saying what you looked at. This is final.
4. Never "retry" from outside the platform. After **Not applied** the agent may request it
   again, through the usual policy and approval.

If you cannot tell, leave it waiting and escalate: a wrong **Not applied** can duplicate it.

## Responding to Vault failures

Alerts `secret-store-unavailable`, `secret-missing`. Actions and model calls that need a
secret are refused; nothing is called without it, and runs fail rather than wait.

- Unavailable: check Vault health and that the token at `VAULT_TOKEN_PATH` is current (the
  Vault agent renews it; it is read on each use, so no restart is needed).
- Missing: a `secret://` reference names no entry under the organization's path. Create the
  entry in Vault, or correct the reference on the connection or model credential.
- Confirm with `npm run pilot:validate -- --scope control-plane`.

## Responding to artifact failures

Alert `object-store-failures`: uploads and downloads are refused with
`ARTIFACT_STORE_UNAVAILABLE` and runtimes store again once it returns. Check the bucket,
`ARTIFACT_S3_ENDPOINT` and the credentials file at `ARTIFACT_S3_CREDENTIALS_PATH`, then
validate.

Alert `artifact-integrity` is an incident: stored bytes did not match their hash. The object
was deleted and never served. [Collect evidence](#collecting-evidence-for-an-incident), check
the bucket's access logs for writers other than the control plane, and keep the bucket's
versioning history.

## Responding to database failures

Alert `database-connections`: transactions are retried for about three seconds, then requests
fail and runtimes retry. Check the database host, connection limits and failover.

Alert `checkpoint-corrupt`: a stored checkpoint failed verification, and its run failed
closed. Treat it as an incident, like an integrity failure.

After a database restore, run `npm run pilot:validate`: the control plane refuses to start on
a schema that is not exactly this release's.

## Rotating credentials

Values live only in Vault and are read at the moment of use, so rotating a value in place
needs no restart:

1. Write the new value to the same Vault entry. The next use reads it.
2. Revoke the old value at the provider (Jira, GitHub, the model provider).

To move to a new entry instead:

- Model provider: `PUT /api/organization/model-credentials/<provider>` with
  `{ "secretRef": "secret://<new-name>" }`; `POST .../<provider>/disable` stops its use.
- Source control: create the new connection (`POST /api/organization/source-control-connections`),
  then disable the old one (`POST .../<id>/disable` with its `version`). Outstanding checkout
  leases are listed at `/api/organization/credential-leases` and can be revoked there.
- Connector (Jira, GitHub actions): create a new connection and disable the old one under
  `/api/organization/connector-connections`.

Alerts `credential-lease-failures`, `connector-failures` and `model-failures` after a rotation
mean the new value is wrong or not yet granted.

## Cancelling a run

The employee who started it cancels it with `POST /api/execution/v1/runs/<run id>/cancel`. The runtime stops at its next step; nothing
already approved is undone. A write it had sent with no answer appears under
[writes to reconcile](#handling-writes-to-reconcile).

## Recovering a stuck run

Alerts `lease-expired`, `recovery-rate-low`, `runs-abandoned`, `queue-backlog`.

1. Check that agent runtimes serving the organization are running and can reach the control
   plane (`af_runtime_control_plane_retries_total`).
2. A run whose runtime stopped is continued by another runtime after its lease expires, up to
   ten minutes, from its last checkpoint. No action is repeated.
3. A run waiting for approval is not stuck: see the approval wait panel.
4. A run nothing can continue is cancelled as abandoned. The employee starts it again.

Do not edit run, lease or checkpoint rows by hand.

## Collecting evidence for an incident

Collect identifiers, never content or secrets:

- run, thread, request and approval identifiers, and the time window;
- `GET /api/execution/v1/runs/<run id>` and `/actions` and `/events` (as the run's owner or an
  administrator);
- the run's trace (`af.run.id`) and the dashboard panels for the window;
- audit events for the run (`action.*`, `runtime.action.*`, `approval.*`) from the database;
- the latest `pilot:validate` report;
- for evidence files, retrieve them through the API, which verifies their hash.

## Rolling back the pilot

1. Tell pilot users; pause new work by stopping agent runtimes with `SIGTERM` (runs pause or
   end; none is lost).
2. Resolve every [write to reconcile](#handling-writes-to-reconcile) first.
3. Deploy the previous release of all three processes together.
4. Migrations are additive and never edited, but a release refuses a schema newer than its
   own. If the release being rolled back added a migration, restore the database backup taken
   before that deployment, or roll forward with a fix instead.
5. Run `npm run pilot:validate` and the smoke workflow on the restored deployment before
   letting users back in.
