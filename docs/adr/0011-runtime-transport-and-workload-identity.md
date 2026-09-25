# ADR 0011: Runtime transport, workload identity and the in-repository runtime

- Status: Accepted
- Date: 2026-09-25

## Context

Phase C needs a real agent runtime process and a way for it to reach the control plane.
ADR 0002 forbids exposing run-history ingestion until runtimes have a workload identity.
Runtime approvals must be impossible to race: a human decision must never arrive before the
run is paused. ADR 0002 also planned a separate `agent-runtime` repository, but
`@agents-foundry/contracts` is not published, so a separate repository would have to copy the
protocol types.

## Decision

1. **Runtime location.** The runtime lives in `apps/agent-runtime`. It is a separate npm
   workspace, process and deployable, and it is not part of the control-plane build. It may
   import only `packages/contracts`, `zod` and Node built-ins. A test enforces that boundary.
   It moves to its own repository once contracts are published as a versioned package.
2. **Workload identity.** Each runtime has an Ed25519 key pair. Operators register only the
   public key, with the tenants (`organizations`, or `["*"]` for a platform-operated runtime)
   and runtime profiles it may serve (`AGENT_RUNTIME_IDENTITIES_PATH`). Every request is
   signed over `AF-RUNTIME-V1`, the method, the path, the timestamp, the nonce and the SHA-256
   of the body. Requests are rejected with the same 401 when the clock skew exceeds five
   minutes or a nonce is reused. The control plane stores no runtime secret.
3. **Transport.** The transport is pull-based HTTP under `/runtime/v1`, outside `/api`, so
   cookies, sessions and demo headers never apply there:
   - `commands/claim` leases one run to one runtime.
   - `events` ingests `runtime/v1` events.
   - `actions` decides governed actions.

   Tenancy comes from the stored run and lease, never from the message. A runtime can only
   act on runs it holds a lease for.

4. **Governed actions pause atomically.** Before a tool performs a governed action, the runtime
   asks the control plane. The decision is the more restrictive of two sources:
   - the policy engine;
   - the manifest's pinned capability.

   Before that, the control plane checks that the tool is in the manifest, that the tool
   version matches the catalog bundle pinned by digest, and that the tool declares the action.
   Any failure denies. For `REQUIRE_APPROVAL`, one transaction creates the approval, pauses
   the step and the run, and records `approval.requested` and `run.paused`. Runtimes do not
   emit `run.paused`.

5. **Resume.** An approval re-queues the run (ADR 0008). The next claim by the runtime that
   holds the lease receives `run.resume`. `run.resumed` must name an approved approval linked to
   the run. The approved step then restarts. Resume stays with that runtime because the kernel
   checkpoint is local to it.
6. **Kernel boundary.** `AgentKernel` (ADR 0006) with a first-party `NativeKernel`. Kernels
   receive a context with an event sink, an action-request function, a model gateway, the
   manifest-filtered tools and an artifact store. They never see transport, credentials or
   checkpoint storage, and never emit run lifecycle events.

## Consequences

- Browser sessions can never write run history or request actions.
- A stolen runtime key is limited to that runtime's tenants and profiles. Leases also limit it
  to runs it claimed. Rotate the key by replacing the public key in configuration.
- If the runtime holding a paused run is lost, the run stays queued for resume. It is not
  silently restarted elsewhere. Checkpoint replication is future work.
- The runtime-side action request is the Phase C slice of the Action Gateway (ADR 0005).
  Phase D adds connector dispatch, secret resolution and contextual policy on the same record
  (`agent_action_requests`).
