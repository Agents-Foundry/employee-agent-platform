# ADR 0013: Execution runtime authorized by signed grants

- Status: Accepted
- Date: 2026-09-26

## Context

ADR 0007 moves dangerous work (git, shell, filesystem, browsers) into an execution runtime.
Something must authorize each operation there. Trusting the agent runtime would let a
compromised runtime, or a model steering it, run anything the execution host can reach. The
control plane already decides and approves governed actions (ADR 0005, ADR 0012), but it
must not run shells or browsers itself (ADR 0002).

## Decision

1. **Execution grants.** For actions performed by an execution runtime (`repository.read`
   and `qa.execute_playwright` so far), the runtime sends the exact `ExecutionOperation` as
   the action `parameters`. After an allow or an approval, the runtime calls
   `POST /runtime/v1/actions/grant`. The control plane re-authorizes the request and signs
   one grant with its Ed25519 key. The grant is signed over a domain-separated input
   (`agents-foundry/execution-grant/v1\n` + canonical JSON), so it cannot be confused with a
   manifest. It binds:
   - the request, action and full correlation (organization, employee, agent, thread, run,
     step, tool call);
   - the operation kind and its canonical SHA-256;
   - the required isolation, from the signed manifest;
   - resource limits;
   - a lifetime of at most 10 minutes, and never beyond the approval's expiry.

   There is one grant per request. It is stored immutably, and redelivering it is safe
   because use is single.

2. **Scope from the agent's own configuration.** At decision time the control plane checks
   the operation's target against the agent's signed configuration. A checkout must name the
   configured repository (ignoring host case, a trailing slash and a `.git` suffix). A
   Playwright run must target the configured QA origin. Out-of-scope operations are denied by
   Policy v2 (`resource.inScope = false`). Operation kinds a tool does not own are denied
   (`OPERATION_NOT_ALLOWED`). `command` and `file.write` are never granted in this phase.
3. **The execution runtime trusts only the grant.** `apps/execution-runtime` is a separate
   process that imports only contracts. It verifies the signature against the pinned
   control-plane key, the expiry, and that the presented operation matches the digest. It
   uses each grant once and stores the response, so a replay returns the recorded result
   instead of running again. It does not trust the agent runtime, the model or the request
   body.
4. **Workspaces** belong to (organization, employee, agent, thread), taken from the grant. A
   registry records them. A workspace whose directory disappears is marked `LOST` and every
   later operation fails with `WORKSPACE_LOST`: it is never silently recreated. Operations in
   one workspace run one at a time.
5. **Providers declare what they enforce.** `ExecutionProvider` reports its isolation and the
   limits it enforces. `LocalExecutionProvider` confines paths to the workspace (lexically,
   then after resolving symlinks). It scrubs the environment: its own secrets are not
   inherited, and it gives each process a private HOME and TMP and an empty git config. It
   runs executables from an argument list (never a shell), enforces wall-clock timeouts that
   kill the whole process tree, and caps output. It disables git hooks, credential helpers,
   templates and, by default, `file://` repositories. It does **not** enforce CPU, memory,
   process-count or network limits, so it reports `isolation: 'local'`, and grants requiring
   a sandbox are refused unless the operator sets `EXECUTION_ALLOW_UNSANDBOXED=true`.
6. **Evidence.** Execution output (logs, the Playwright JSON report) is stored by the
   execution runtime as artifacts and returned as registrations. The agent runtime records
   them on the run with `artifact.created`, and only a bounded text summary reaches the model.

## Consequences

- A compromised agent runtime can only run operations the control plane allowed or a human
  approved, each exactly once, within the agent's configured repository and QA origin.
- Production deployments need a sandboxing provider (a container or micro-VM with network
  egress limited to the grant's allow-list) before sandboxed agents run with real isolation.
- There is no dependency installation yet. `playwright.run` requires `@playwright/test` to be
  present in the checked-out project, and fails with `PLAYWRIGHT_NOT_INSTALLED` otherwise.
- Private repositories need a credential flow (secret references resolved inside the
  execution runtime), which is future work. Only public HTTPS repositories work today.
