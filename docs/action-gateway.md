# Action Gateway

The Action Gateway decides, approves and executes governed actions for agent runs
([ADR 0005](adr/0005-action-gateway.md), [ADR 0012](adr/0012-action-gateway-execution.md)).
Code lives in `apps/control-plane-api/src/actions/`, and Policy v2 is in
`packages/policy-engine`.

**Status (Phase D):** implemented for `jira.issue.create`, end to end:

- runtime tool `issue-tracker`;
- payload-bound approval;
- single-use execution;
- the Jira Cloud connector.

Other governed actions stay runtime-executed after an allow or approval decision (Phase C).

## Flow

```text
runtime tool ──► POST /runtime/v1/actions {parameters, inputDigest}
                 ├─ manifest, catalog tool, connector capability, parameters, digest, scope
                 ├─ Policy v2: platform ∧ manifest ∧ organization override ∧ resource scope
                 └─ ALLOWED | DENIED | APPROVAL_REQUIRED (approval + pause, expires_at)
admin approves ─► run re-queued ─► runtime run.resume ─► run.resumed
runtime tool ──► POST /runtime/v1/actions/execute {requestId}
                 ├─ re-authorize (policy, approval APPROVED and unexpired, connection, secret)
                 ├─ insert execution DISPATCHING (single use)
                 ├─ connector call (secret resolved now, never stored)
                 └─ SUCCEEDED {issueKey, url} | FAILED {code}
```

## Decision reasons

- **Denials the gateway returns before policy is evaluated:**
  - `MANIFEST_INVALID`
  - `TOOL_NOT_IN_MANIFEST`
  - `BLUEPRINT_UNAVAILABLE`
  - `BLUEPRINT_DIGEST_MISMATCH`
  - `TOOL_VERSION_MISMATCH`
  - `ACTION_NOT_GOVERNED_BY_TOOL`
  - `ACTION_NOT_IN_MANIFEST`
  - `PARAMETERS_REQUIRED`
  - `PARAMETERS_INVALID`
  - `INPUT_DIGEST_MISMATCH`
  - `CONNECTOR_NOT_CONFIGURED`
  - `CONNECTOR_CAPABILITY_MISSING`
  - `POLICY_UNAVAILABLE`
- **Policy v2 reasons** are sentences, such as "Restricted by organization policy." or "The
  target resource is outside the configured scope."
- **Execution refusal codes:**
  - `ACTION_DENIED`
  - `APPROVAL_NOT_GRANTED`
  - `APPROVAL_EXPIRED`
  - `POLICY_DENIED`
  - `APPROVAL_REQUIRED`
  - `CONNECTOR_NOT_CONFIGURED`
  - `SECRET_UNRESOLVED`
- **Connector failure codes:**
  - `CONNECTOR_REQUEST_FAILED`
  - `CONNECTOR_RESPONSE_INVALID`
  - `CONNECTOR_FAILED`

## Administration (password mode, organization admins)

| Route                                                      | Purpose                                                |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `GET/POST /api/organization/connector-connections`         | List or add a connection (secret reference only)       |
| `POST /api/organization/connector-connections/:id/disable` | Disable with optimistic `version`                      |
| `GET /api/organization/action-policies`                    | Governed actions, defaults, executor and overrides     |
| `PUT /api/organization/action-policies/:action`            | Override to `REQUIRE_APPROVAL` or `DENY` with a reason |
| `DELETE /api/organization/action-policies/:action`         | Return to the platform default                         |

The admin console's **Governed actions and connections** panel uses these routes. Approval
rows show the target resource and the expiry time.

## Secrets

Connections store `secret://<name>`. The operator secret file (`CONNECTOR_SECRETS_PATH`) is
scoped per organization:

```json
{ "<organizationId>": { "jira-api-token": "<token>" } }
```

It is read at each dispatch, so tokens rotate without a restart. Values never enter the
database, audit metadata, run events, runtime messages or the browser.

## Data

Migration 009 adds:

- `approvals.expires_at`;
- `agent_action_requests.parameters`, `policy_id` and `policy_version`;
- `organization_connector_connections` (no deletes; one active connection per provider);
- `organization_action_policies`;
- `agent_action_executions` (single use; its status changes only once, from `DISPATCHING`).

## Limitations

- One control-plane action and one connector: Jira Cloud issue creation. Azure DevOps, Linear,
  GitHub and GitLab connectors follow the same registry shape.
- Egress protection is URL validation only. There is no DNS-rebinding defence or egress proxy
  yet.
- A dispatch interrupted by a crash stays `DISPATCHING` and needs manual reconciliation.
- Secrets come from an operator file; a managed vault integration is future work.
