# ADR 0034: Organization-managed model credentials through the secret broker

- Status: Accepted
- Date: 2026-10-01

## Context

`ORGANIZATION_MANAGED` model keys were read from the agent runtime's environment
(`AF_MODEL_API_KEY_<PROVIDER>`): one long-lived key per runtime process, shared by every
organization it serves, outside the secret broker and its audit trail.

## Decision

1. **A reference per organization and provider.** `organization_model_credentials` holds a
   `secret://` reference, under forced row-level security. Administrators set, replace and
   disable it (`/api/organization/model-credentials`). Manifests still carry only the provider,
   model and credential mode.
2. **The runtime asks for the key for each model call.**
   `POST /runtime/v1/models/credential` returns it only when:
   - the request is signed by an agent runtime identity;
   - that runtime holds the lease of the run, and the run is `RUNNING`;
   - the correlation matches the stored run;
   - the provider is the one the run's signed manifest names;
   - the manifest's credential mode is `ORGANIZATION_MANAGED`;
   - the organization has an active reference, and the secret broker resolves it.

   Every issue and refusal is audited without the key. Nothing is cached, so replacing or
   disabling the reference takes effect on the next call.

3. **The key stays in memory.** The runtime holds it for one call. It is never logged or put
   in an event, and the host refuses to save a checkpoint that contains it (ADR 0032). It does
   not appear in manifests, events, audit metadata, checkpoints, artifacts, model-quality
   reports, budget alerts or webhooks.
4. **Environment keys are a development fallback**, used only when
   `AGENT_RUNTIME_ENV_MODEL_KEYS=true` and the organization has no credential.
5. **`EMPLOYEE_BYOK` still fails closed**, in the runtime and in the control plane
   (`MODEL_CREDENTIAL_UNAVAILABLE`). An employee's key is never sent to or through the control
   plane.

## Employee-held keys

Secure employee BYOK needs a different execution path, not a server runtime with the
employee's key:

- The key stays in the operating system's credential store on the employee's device, where
  the desktop application already keeps it.
- Model calls for a BYOK agent are made **on the device**, by a desktop-local agent runtime
  with its own workload identity, registered for that one employee. It speaks the same
  `agents-foundry/runtime/v1` transport: it claims only that employee's runs, and the control
  plane still decides every governed action, meters model usage and receives events.
- Tools that need a workspace still run in the execution runtime under signed grants, so the
  device never gains repository or connector access of its own.
- A BYOK run can only progress while the employee's device is online. Checkpoints (ADR 0032)
  let it continue after the device sleeps.

This is not implemented. Until it is, a BYOK agent cannot run on a server runtime.

## Consequences

- An agent runtime that serves an organization can obtain that organization's model key while
  it holds one of its running runs. The key is scoped by the provider's own controls, not by
  run.
- Each model call adds one request to the control plane and one secret resolution.
- Existing deployments must store each organization's key in the secret store and set its
  reference, or enable the development fallback.
