# Pilot environment setup checklist

Everything that must exist before `pilot:validate` and the **Pilot smoke** workflow can produce
the six live proofs (ADR 0039). Work top to bottom: each section is what a later check needs.
The checks named in brackets are the `pilot:validate` checks or smoke steps that fail without
the item. When everything is ticked, follow
[Validating a deployment](pilot-runbook.md#validating-a-deployment).

Rules that apply throughout:

- No secret value goes into a variable, a command line or this repository. Services read
  secrets from files (`*_PATH`) or from Vault; GitHub holds the two smoke account secrets.
- Deploy one commit to every host and record it as `PILOT_RELEASE_COMMIT`. Reports for any
  other commit do not count.
- The smoke writes only to the disposable Jira project and repository below. Never point it at
  anything a customer or colleague uses.

## 1. Decisions

- [ ] Pilot owner and on-call operator named.
- [ ] Hosts chosen: one control-plane host (API and web), at least one agent-runtime host, at
      least one execution-runtime host with Docker. The execution host needs no inbound access
      from the internet.
- [ ] Public HTTPS URL of the API (`PILOT_BASE_URL`) and of the web app (`PILOT_SMOKE_ORIGIN`).
- [ ] The commit to deploy: a green commit on `main`.
- [ ] The model provider for the pilot (`PILOT_MODEL_PROVIDER`), and its monthly budget.

## 2. PostgreSQL

- [ ] PostgreSQL reachable from the control-plane host over TLS, with encryption at rest
      enabled (checkpoints rely on it: limitation `checkpoints-not-encrypted`).
- [ ] Two logins, both distinct from the owner:
  - tenant login, member of `af_tenant`, **not** superuser and **not** `BYPASSRLS`
    (`DATABASE_URL`);
  - platform login, member of `af_platform` (`DATABASE_PLATFORM_URL`).
    [database.connectivity, database.roles, database.row-level-security]
- [ ] Migrations of the deployed commit applied, none edited [database.migrations].
- [ ] Automated backups with a tested restore; point-in-time recovery for the rollback in the
      runbook.

## 3. Vault

- [ ] Vault reachable over HTTPS from the control-plane host (`VAULT_ADDR` starts with
      `https://`) [flags.development-fallbacks].
- [ ] A KV v2 mount for the platform (`VAULT_KV_MOUNT`; optional `VAULT_KV_PREFIX`,
      `VAULT_NAMESPACE`).
- [ ] A token or agent sink file readable only by the control-plane service
      (`VAULT_TOKEN_PATH`), with a policy limited to that mount and prefix.
- [ ] `SECRET_PROVIDER=vault`; `CONNECTOR_SECRETS_PATH` unset.
- [ ] A health-check secret named `pilot-healthcheck` (or `PILOT_HEALTHCHECK_SECRET`) in the
      pilot organization's path [vault.health-secret → `vault-live`].

## 4. Object store

- [ ] An S3-compatible bucket for artifacts, private, with versioning or retention set by the
      pilot owner (`ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_REGION`, optional `ARTIFACT_S3_ENDPOINT`,
      `ARTIFACT_S3_PREFIX`).
- [ ] Credentials limited to that bucket and prefix, in a JSON file readable only by the
      service (`ARTIFACT_S3_CREDENTIALS_PATH`).
- [ ] `ARTIFACT_STORE=s3`, `ARTIFACTS_REQUIRE_MANAGED=true`
      [object-store.round-trip → `object-store-live`].

## 5. Telemetry

- [ ] An OTLP/HTTP collector reachable from every service (`OTEL_EXPORTER_OTLP_ENDPOINT`), with
      any auth headers in a file (`TELEMETRY_OTLP_HEADERS_PATH`).
- [ ] `TELEMETRY_EXPORTER=otlp` on every service [telemetry.otlp → `telemetry-live`].
- [ ] Prometheus rules and the Grafana dashboard from `operations/` loaded, with
      `alert-thresholds.json` if any threshold differs (`npm run ops:render`); alerts routed to
      the on-call operator.

## 6. Identities and signing keys

- [ ] Manifest signing key generated on the control-plane host, file mode `600`
      (`MANIFEST_SIGNING_KEY_PATH`) [signing.manifest-key].
- [ ] Its public key configured on every execution host (`EXECUTION_GRANT_VERIFICATION_KEY`)
      [signing.execution-verifies].
- [ ] A workload key pair per agent runtime and per execution runtime; their public keys and
      the organizations they serve in the identities file (`AGENT_RUNTIME_IDENTITIES_PATH`),
      including the pilot organization [runtimes.identities].

## 7. Execution hosts

- [ ] Docker installed; the sandbox, Playwright and (optional) egress proxy images loaded
      locally, since images are never pulled (`EXECUTION_SANDBOX_IMAGE`,
      `EXECUTION_PLAYWRIGHT_IMAGE`, `EXECUTION_EGRESS_PROXY_IMAGE`) [sandbox.images].
- [ ] `EXECUTION_PROVIDER=container` and the egress proxy enabled; `EXECUTION_RUNTIME_URL`
      reachable from the control plane [execution.reachable, sandbox.egress-proxy].
- [ ] Host firewall: sandboxes reach the network only through the egress proxy.

## 8. Service configuration

- [ ] Pilot flags exactly `true` on the control plane [flags.pilot]:
      `GENERIC_AGENT_RUNTIME_ENABLED`, `AGENT_MANIFEST_V2_ISSUANCE_ENABLED`,
      `QA_GENERIC_RUNTIME_ENABLED`, `ARTIFACTS_REQUIRE_MANAGED`.
- [ ] Development fallbacks off [flags.development-fallbacks]:

  | Variable                              | Required                 |
  | ------------------------------------- | ------------------------ |
  | `NODE_ENV`                            | `production`             |
  | `AUTH_MODE`                           | `password` or `google`   |
  | `SECRET_PROVIDER`                     | `vault`                  |
  | `CONNECTOR_SECRETS_PATH`              | unset                    |
  | `ARTIFACT_STORE`                      | `s3`                     |
  | `TELEMETRY_EXPORTER`                  | `otlp`                   |
  | `EXECUTION_PROVIDER`                  | `container`              |
  | `EXECUTION_ALLOW_UNSANDBOXED`         | not `true`               |
  | `EXECUTION_ALLOW_UNRESTRICTED_EGRESS` | not `true`               |
  | `EXECUTION_EGRESS_PROXY`              | not `false`              |
  | `EXECUTION_ALLOW_FILE_REPOSITORIES`   | not `true`               |
  | `AGENT_RUNTIME_ENABLE_SCRIPTED_MODEL` | not `true`               |
  | `AGENT_RUNTIME_ENV_MODEL_KEYS`        | not `true`               |
  | `AGENT_RUNTIME_CHECKPOINT_STORE`      | unset or `control-plane` |
  | `AGENT_RUNTIME_ARTIFACT_STORE`        | unset or `control-plane` |

- [ ] Validator settings on the control-plane host: `PILOT_ORGANIZATION_ID`,
      `PILOT_MODEL_PROVIDER`, `PILOT_RELEASE_COMMIT`, `PILOT_ENVIRONMENT=pilot`.

## 9. Pilot organization

- [ ] The pilot organization created, with its first administrator (who is not a smoke account).
- [ ] An active model credential for `PILOT_MODEL_PROVIDER`: the key stored in Vault, the
      reference set by an administrator (`/api/organization/model-credentials`, ADR 0034)
      [model.credential → `vault-live`].
- [ ] A model budget set for the organization.

## 10. Smoke organization and disposable resources

A separate organization, so smoke runs never touch the pilot organization's data.

- [ ] Smoke organization created (`PILOT_SMOKE_ORGANIZATION_ID`), with its own model credential
      and a small budget.
- [ ] Two accounts in it, different people, each able to sign in with a password (the smoke
      signs in through `/api/auth/password`, which works with `AUTH_MODE` `password` or `google`):
  - an employee, assigned the QA agent;
  - an administrator, who approves the smoke run's write.
- [ ] The QA agent assigned to the employee (`PILOT_SMOKE_AGENT_ID`).
- [ ] A disposable Jira project, used by nothing else (`PILOT_SMOKE_JIRA_PROJECT`), with one
      story to test (`PILOT_SMOKE_STORY_KEY`).
- [ ] A disposable private repository, used by nothing else (`PILOT_SMOKE_REPOSITORY`,
      `owner/name`), holding a small web app with tests and Playwright checks.
- [ ] The URL of the app under test (`PILOT_SMOKE_TARGET_URL`), allowed by the egress list.
- [ ] Jira and GitHub connections in the smoke organization restricted to exactly that project
      and that repository. The smoke refuses to start if a connection reaches anything else.
- [ ] The source-control credential for the repository stored in Vault, never in a variable.

## 11. GitHub `pilot` environment

Create the environment **before** the first dispatch. A workflow that names a missing
environment creates it without protection.

- [ ] Settings → Environments → New environment `pilot`.
- [ ] Required reviewers: the pilot owner and one other person; prevent self-review.
- [ ] Deployment branches: selected branches, `main` only.
- [ ] Variables:
      `PILOT_BASE_URL`, `PILOT_SMOKE_ORIGIN`, `PILOT_SMOKE_ORGANIZATION_ID`,
      `PILOT_SMOKE_AGENT_ID`, `PILOT_SMOKE_STORY_KEY`, `PILOT_SMOKE_TARGET_URL`,
      `PILOT_SMOKE_JIRA_PROJECT`, `PILOT_SMOKE_REPOSITORY`,
      `PILOT_SMOKE_RESOURCES_DISPOSABLE=true` (state this only once section 10 is true).
- [ ] Secrets, each `{"email": "...", "password": "..."}`:
      `PILOT_SMOKE_EMPLOYEE_CREDENTIALS`, `PILOT_SMOKE_ADMIN_CREDENTIALS`.

## 12. Run the proofs

- [ ] Deploy `PILOT_RELEASE_COMMIT` to every host and start the services
      ([Starting and stopping runtimes](pilot-runbook.md#starting-and-stopping-runtimes)).
- [ ] Control-plane host: `npm run pilot:validate -- --scope control-plane`
      (`vault-live`, `object-store-live`, `telemetry-live`).
- [ ] Each execution host: `npm run pilot:validate -- --scope execution-host`.
- [ ] Actions → **Pilot smoke** → Run workflow on `main`, release = the deployed commit; a
      reviewer approves the `pilot` environment (`sandbox-live`, `private-scm-live`,
      `real-model-live`, and `object-store-live` and `vault-live` again).
- [ ] Copy the validate reports and the `pilot-smoke-report` artifact into
      `.readiness/operational/` of a checkout of the deployed commit, unedited.
- [ ] `npm run readiness` prints **Ready for a controlled pilot**, with `codeProofsPassed`,
      `operationalProofsPassed` and `readyForControlledPilot` all `true`. Proofs expire after
      seven days and on any new deployment.
