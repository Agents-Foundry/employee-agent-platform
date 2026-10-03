# ADR 0035: Provider-neutral traces and metrics on the platform's own correlation

- Status: Accepted
- Date: 2026-10-02

## Context

Operating a pilot needs two things the platform did not have: a way to follow one run across
the control plane, the agent runtime and the execution runtime, and numbers that say whether
runs, leases, checkpoints, models, tools, approvals, credentials, connectors and the artifact
store are healthy. The audit trail records decisions; it is not a tracing or metrics system.

Telemetry is also a place where content leaks. A span attribute or a metric label that holds a
prompt, a model response, a file, a connector payload or a token ends up in a system with a
wider audience and a longer retention than the run itself.

## Decision

1. **One small package, no vendor.** `packages/telemetry` defines spans, counters, histograms
   and gauges in OpenTelemetry's terms and exports them as OTLP/HTTP JSON, as Prometheus text,
   or as JSON lines. It depends on nothing. The three processes import it; nothing in it knows
   about a role.
2. **A run is a trace; the platform's identifiers are the hierarchy.** The trace identifier is
   derived from the run identifier, and each span identifier from the identifier the platform
   already gave the thing: a step, a tool call, an action request, an approval, a grant, a
   credential lease, an artifact, a model reservation. Any process can therefore name a span's
   parent from the correlation it already holds. No tracing header is passed between
   processes, and no second hierarchy exists that could disagree with the first.

   ```
   agent.run                       (thread and organization are attributes)
   ├─ run.step (MODEL)
   │   └─ model.call               agent runtime
   │       └─ model.budget.reserve control plane, same reservation id
   ├─ run.step (TOOL)
   │   ├─ tool.call                agent runtime
   │   │   ├─ action.decision      Action Gateway
   │   │   │   ├─ connector.dispatch
   │   │   │   └─ execution.grant
   │   │   │       ├─ credential.lease
   │   │   │       └─ execution.operation   execution runtime
   │   │   └─ artifact.upload
   │   │       └─ artifact.retrieve
   │   └─ approval.wait
   ├─ checkpoint.save
   └─ run.recovery
   ```

3. **Content cannot be attached.** Attribute names are a closed list
   (`ATTRIBUTE_KEYS`). A string value must look like an identifier: no spaces, no quotes, at
   most 128 characters. Anything else is dropped and counted. Metric names, label names and
   help text are fixed in one catalog (`METRICS`); label values are sanitized the same way, and
   a metric keeps at most 500 label combinations.
4. **Tenant and run identifiers are correlation, not labels.** Spans carry the organization,
   thread and run identifiers. Metrics carry none of them, and no span or metric carries an
   employee identifier, an email address, a URL or a repository name.
5. **Measured after commit.** Anything counted for a database change is counted once that
   transaction has committed (`PgStore.afterCommit`), so a rolled-back or retried transaction
   is not counted twice.
6. **Telemetry never fails work.** Exporters and gauge collectors cannot throw into a request.
   A collector that is down costs telemetry, which is counted
   (`af_telemetry_dropped_total`), and nothing else.
7. **Metrics are pulled or pushed.** The control plane and the execution runtime serve
   `GET /metrics` to a scraper that presents the operator's bearer token
   (`METRICS_TOKEN_PATH`, `EXECUTION_METRICS_TOKEN_PATH`); without the setting the route does
   not exist. The agent runtime has no HTTP server and pushes over OTLP.

## Metrics

| Area                 | Metrics                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs                 | `af_runs{status}`, `af_runs_created_total`, `af_runs_finished_total{status,reason}`, `af_run_duration_ms`, `af_run_queue_wait_ms`                             |
| Leases and recovery  | `af_runtime_leases{state}`, `af_runtime_leases_expired_total`, `af_run_recoveries_total{command}`, `af_runs_abandoned_total{code}`                            |
| Checkpoints          | `af_checkpoint_writes_total{result}` (saved, conflict, stale session, digest or binding mismatch), `af_checkpoint_reads_total{result}`, `af_checkpoint_bytes` |
| Models               | `af_model_latency_ms`, `af_model_calls_total`, `af_model_tokens_total{direction}`, `af_model_cost_micros_total`, `af_model_budget_decisions_total`            |
| Tools and actions    | `af_tool_calls_total`, `af_tool_duration_ms`, `af_action_decisions_total{action,decision}`, `af_action_executions_total`, `af_action_reconciliations_total`   |
| Approvals            | `af_approvals_total{action,status}`, `af_approval_wait_ms`                                                                                                    |
| Execution            | `af_execution_grants_total`, `af_execution_operations_total`, `af_execution_duration_ms`, `af_execution_in_flight`, `af_execution_refusals_total{code}`       |
| Sandbox and egress   | `af_sandbox_startup_ms`, `af_egress_denials_total`, `af_egress_failures_total{code}`                                                                          |
| Credentials, secrets | `af_credential_leases_total{event,code}`, `af_secret_resolutions_total{provider,result}`, `af_secret_resolution_ms`                                           |
| Connectors           | `af_connector_duration_ms{provider,action,outcome}`, `af_connector_errors_total`                                                                              |
| Artifacts            | `af_artifact_uploads_total{source,result}`, `af_artifact_upload_bytes_total`, `af_artifact_retrievals_total`, `af_artifact_integrity_failures_total`          |
| Dependencies         | `af_object_store_failures_total{operation}`, `af_database_retries_total{reason}`, `af_runtime_control_plane_retries_total`, `af_telemetry_dropped_total`      |

## Consequences

- An execution runtime has no queue: `af_execution_in_flight` and
  `af_execution_refusals_total{code="WORKSPACE_BUSY"}` are its load signals.
- `af_sandbox_startup_ms` is the time to prepare the sandbox (its private network and egress
  proxy) before the operation's container is started, not the container's own start time.
- Spans whose start and end are in different requests (a run, a step, an approval) are written
  when they end, from the times the control plane recorded.
- No dashboards or alert rules are shipped, and the exporters have not been run against a
  live collector. Both are listed in the pilot-readiness assessment (ADR 0038).
