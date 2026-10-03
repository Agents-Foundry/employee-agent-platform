# Observability

Traces and metrics for operating the platform. The design and the full metric list are in
[ADR 0035](adr/0035-observability.md); this page is the operator's view.

## What you get

- **One trace per run.** The control plane, the agent runtime and the execution runtime write
  spans into the same trace without passing headers to each other, because trace and span
  identifiers are derived from the run and from the identifiers the platform already assigns.
  To find a run's trace, search your tracing backend for the attribute `af.run.id`.
- **Metrics** for runs, leases, recoveries, checkpoints, models, budgets, tools, Action Gateway
  decisions, approvals, execution, sandbox and egress, credential leases, secrets, connectors,
  artifacts, the artifact store and the database.

Telemetry holds identifiers and measurements only. It never holds a prompt, a model response,
a document, a connector payload, a URL, an email address, an employee identifier or a secret:
attribute names are a closed list and values must look like identifiers.

## Configuration

Set on each process (control plane, agent runtime, execution runtime):

| Variable                       | Default | Purpose                                                                                  |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `TELEMETRY_EXPORTER`           | `none`  | `none` (metrics kept for `/metrics` only), `console` (one JSON line per span) or `otlp`  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | unset   | Collector base URL for `otlp`, for example `https://otel-collector.internal:4318`. HTTPS |
| `TELEMETRY_OTLP_HEADERS_PATH`  | unset   | JSON file of extra request headers (collector authentication), read on every export      |
| `METRICS_TOKEN_PATH`           | unset   | Control plane: file with the bearer token a scraper must present to `GET /metrics`       |
| `EXECUTION_METRICS_TOKEN_PATH` | unset   | Execution runtime: the same, for its `GET /metrics`                                      |

- With `otlp`, spans and metrics are pushed to `<endpoint>/v1/traces` and
  `<endpoint>/v1/metrics` as OTLP/HTTP JSON every ten seconds.
- `GET /metrics` serves Prometheus text. It exists only when a token path is set; the token
  must be at least 32 characters and is read on every request, so it can be rotated in place.
- The agent runtime has no HTTP server: use `otlp` there.
- An unknown exporter name, or `otlp` without an endpoint, stops the process at startup.

## What to alert on

| Signal                                                               | Means                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `af_runs_finished_total{status="FAILED"}` rising                     | Runs are failing; `reason` says why                                |
| `af_runtime_leases{state="expired"} > 0` for more than a few minutes | A runtime is gone and nothing has picked its runs up               |
| `af_runs_abandoned_total`                                            | Runs were cancelled because nothing could continue them            |
| `af_checkpoint_writes_total{result!="saved"}`                        | Two runtimes on one run, or a corrupted or mismatched checkpoint   |
| `af_model_budget_decisions_total{decision="denied"}`                 | A spending limit is being hit                                      |
| `af_action_reconciliations_total{event="required"}`                  | A write has an unknown outcome: an administrator must reconcile it |
| `af_secret_resolutions_total{result="provider_unavailable"}`         | The secret store is unreachable                                    |
| `af_object_store_failures_total`                                     | The artifact store is failing                                      |
| `af_artifact_integrity_failures_total`                               | Stored bytes do not match their record                             |
| `af_egress_failures_total`, `af_egress_denials_total`                | Egress control is unavailable, or sandboxes are being refused      |
| `af_credential_leases_total{event="refused"}`                        | Credential leases are being refused                                |
| `af_database_retries_total{reason="connection"}`                     | The database is dropping connections                               |
| `af_telemetry_dropped_total`                                         | Telemetry is being lost (collector down, or a caller sent content) |

No dashboards or alert rules are shipped.
