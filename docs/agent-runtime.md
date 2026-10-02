# Agent runtime (`apps/agent-runtime`)

The runtime is a separate process that executes generic agent runs. It speaks
[`agents-foundry/runtime/v1`](runtime-protocol.md) to the control plane over the signed transport
in [ADR 0011](adr/0011-runtime-transport-and-workload-identity.md).

**Status (Phase C):**

- Implemented:
  - the host;
  - the native kernel;
  - the model gateway with an Anthropic adapter;
  - real tools: `artifact`, `issue-tracker` (executed by the control plane, Phase D), and
    `repository` and `browser` (executed by the execution runtime under signed grants, Phase E);
  - approval pause and resume;
  - durable checkpoints, heartbeats and recovery by another runtime
    ([ADR 0032](adr/0032-durable-checkpoints-and-run-recovery.md));
  - artifacts stored in the control plane's artifact store
    ([ADR 0033](adr/0033-durable-artifact-storage.md));
  - organization model keys from the control plane's secret broker
    ([ADR 0034](adr/0034-organization-managed-model-credentials.md)).
- Not implemented yet:
  - connectors, MCP and the execution runtime (Phases D and E);
  - an employee UI for starting runs.

## Components

| Component                      | File                                    | Responsibility                                                                 |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| `RuntimeHost`                  | `src/runtime-host.ts`                   | Claims commands, verifies manifests, owns the run lifecycle and event sequence |
| `ControlPlaneClient`           | `src/transport/control-plane-client.ts` | Ed25519-signed HTTPS requests; strict parsing of responses                     |
| `ManifestVerifier`             | `src/manifest-verifier.ts`              | Verifies v2 manifests against the **pinned** control-plane key                 |
| `AgentKernel` / `NativeKernel` | `src/kernel/`                           | Bounded model ⇄ tool loop; checkpoints after each model turn and tool call     |
| `ModelGateway`                 | `src/models/model-gateway.ts`           | Routes the manifest's provider/model to an adapter; brokers credentials        |
| `AnthropicProvider`            | `src/models/anthropic-provider.ts`      | Messages API over HTTPS, no SDK                                                |
| `ScriptedProvider`             | `src/models/scripted-provider.ts`       | Deterministic replay for tests and offline demos (not a model)                 |
| `ToolRegistry`, `ArtifactTool` | `src/tools/`                            | Tool implementations; the manifest narrows what is offered                     |
| `ControlPlaneCheckpointStore`  | `src/checkpoints.ts`                    | Durable checkpoints kept by the control plane; `FileCheckpointStore` for dev   |
| `ControlPlaneArtifactStore`    | `src/tools/artifact-store.ts`           | Uploads artifact bytes to the control plane; `LocalArtifactStore` for dev      |

## Run flow

1. An employee starts a run: `POST /api/execution/v1/runs` with `agentId` and `task`. This
   route requires `GENERIC_AGENT_RUNTIME_ENABLED=true`, a v2 manifest owned by the caller, and
   a workflow listed in that manifest.
2. The runtime claims `run.submit` and verifies the manifest before anything else:
   - the signature, against the pinned key;
   - the key id;
   - the subject, which must match the correlation;
   - the runtime profile.

   It then emits `run.started`. If verification failed, it emits `run.failed`
   (`MANIFEST_INVALID`) and never calls the model.

3. The kernel loop:
   - Each model turn is a `MODEL` step: `model.requested`, `model.responded`, then
     `agent.message`.
   - Each tool call is a `TOOL` step: `tool.requested`, `tool.started`, `tool.completed`, plus
     `artifact.created` when an artifact is registered.
   - Tool I/O leaves the runtime only as SHA-256 digests.
   - Before each model call the host reserves tokens against the organization's model
     spending limits in tokens and cost (`POST /runtime/v1/models/reserve`, ADRs 0021 and
     0022). It asks the provider for no more output than was granted, then settles the
     reported usage. A denial fails the run with `MODEL_BUDGET_EXCEEDED` without calling the
     provider.
4. A tool that performs a governed action calls `POST /runtime/v1/actions` first:
   - `DENIED`: the tool does not run, and the model receives the denial.
   - `APPROVAL_REQUIRED`: the control plane has already paused the run. The runtime writes a
     checkpoint and stops.
5. An administrator approves, and the runtime claims `run.resume`. It emits `run.resumed`
   naming the approval, runs the approved tool call without asking again, and continues.
   A rejection cancels the run instead, and the runtime receives `run.cancel`.
6. While it executes runs, the runtime sends `POST /runtime/v1/heartbeat` every 30 seconds
   (`AGENT_RUNTIME_HEARTBEAT_MS`). If it stops, its lease expires and another authorized
   runtime is given `run.recover` (or `run.resume` for an approved run). That runtime loads
   the latest checkpoint, verifies it, and continues without repeating finished tool calls.
   See [ADR 0032](adr/0032-durable-checkpoints-and-run-recovery.md).

## Security properties

- **Fail closed:**
  - unknown provider → `MODEL_PROVIDER_UNAVAILABLE`;
  - spending limit reached → `MODEL_BUDGET_EXCEEDED`, or cannot be checked →
    `MODEL_BUDGET_UNAVAILABLE`, with no model call;
  - missing credential or `EMPLOYEE_BYOK` → `MODEL_CREDENTIAL_UNAVAILABLE`;
  - tool not granted → `TOOL_NOT_AVAILABLE`;
  - invalid tool input → `TOOL_INPUT_INVALID`;
  - checkpoint missing → `RUNTIME_CHECKPOINT_MISSING`; altered, in another format or bound
    to something else → `RUNTIME_CHECKPOINT_INVALID`;
  - a checkpoint that would contain a credential → `RUNTIME_CHECKPOINT_SECRET`;
  - the run was taken over by another runtime → this one stops without recording anything;
  - runaway loops → `MAX_TURNS_EXCEEDED`.
- **Model keys:**
  - They are fetched from the control plane for each call
    (`POST /runtime/v1/models/credential`), which resolves the organization's `secret://`
    reference through the secret broker, and only for `ORGANIZATION_MANAGED`.
  - The operator environment (`AF_MODEL_API_KEY_<PROVIDER>`) is a development fallback, used
    only with `AGENT_RUNTIME_ENV_MODEL_KEYS=true`.
  - They are never logged, checkpointed or emitted.
  - Provider error bodies are discarded.
- **No self-approval:**
  - The runtime can neither create nor decide approvals.
  - Approvals are requested for the employee, who cannot approve their own.
- **No shell, browser or filesystem tools** for the model. The artifact tool uploads to the
  control plane's artifact store; the runtime holds no object-store credentials.
- **Checkpoints** contain conversation content. By default they are kept by the control plane,
  under forced row-level security, and deleted when the run ends. With
  `AGENT_RUNTIME_CHECKPOINT_STORE=local` they stay on the runtime host
  (`AGENT_RUNTIME_STATE_DIR`, mode 0600).
- **Logs:** they contain identifiers and error codes only.

## Running locally

```bash
# 1. Create the runtime workload key; note the printed publicKeySpki.
npm run keygen --workspace @agents-foundry/agent-runtime -- ../../.data/runtime-key.pem

# 2. Register it with the control plane (.data/runtime-identities.json):
#    [{"id":"local-runtime","publicKeySpki":"<publicKeySpki>","organizations":["*"],
#      "runtimeProfiles":["standard-agent"]}]

# 3. Control plane .env
#    AGENT_MANIFEST_V2_ISSUANCE_ENABLED=true
#    GENERIC_AGENT_RUNTIME_ENABLED=true
#    AGENT_RUNTIME_IDENTITIES_PATH=../../.data/runtime-identities.json

# 4. Runtime .env. MANIFEST_VERIFICATION_KEY is publicKeySpki from GET /api/manifest-key.
#    CONTROL_PLANE_URL=http://127.0.0.1:4100
#    AGENT_RUNTIME_ID=local-runtime
#    AGENT_RUNTIME_PRIVATE_KEY_PATH=../../.data/runtime-key.pem
#    MANIFEST_VERIFICATION_KEY=<base64 SPKI>
#    AF_MODEL_API_KEY_ANTHROPIC=<organization-managed key>   # or:
#    AGENT_RUNTIME_ENABLE_SCRIPTED_MODEL=true                 # provider "scripted"
npm run dev:runtime
```

Agents must be provisioned with provider `anthropic` (and a model id), or with `scripted` when
the scripted demo model is enabled. Remote control planes must use HTTPS; plain HTTP is
accepted only for loopback addresses.

## Limitations (Phase C)

- `repository` and `browser` are offered only when `EXECUTION_RUNTIME_URL` points at an
  execution runtime (see [execution-runtime.md](execution-runtime.md)). The runtime never runs
  git, shells or browsers itself.
- There is no employee UI for starting or following generic runs. The API and the admin
  approvals panel work.
- Recovery starts when the lease expires, ten minutes after the runtime's last heartbeat.
- With the local checkpoint store, a paused run resumes only on the runtime that paused it,
  and an abandoned running run is cancelled (`RUNTIME_LOST`).
- There is no streaming, context condensation, memory provider or MCP client yet.
