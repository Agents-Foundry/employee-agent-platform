# Execution runtime (`apps/execution-runtime`)

The execution runtime is a separate process that runs workspace operations for agent runs:
repository checkout, git status, file reads and writes, project scripts and Playwright tests. It acts only on
control-plane-signed, single-use execution grants
([ADR 0007](adr/0007-separate-execution-runtime.md),
[ADR 0013](adr/0013-execution-grants.md)).

## Flow

```text
agent runtime tool (repository / browser)
  ├─ POST /runtime/v1/actions   {parameters: <operation>, inputDigest}   → ALLOWED | APPROVAL_REQUIRED | DENIED
  │     scope: checkout = configured repository, playwright = configured QA origin
  ├─ (approval, resume)
  ├─ POST /runtime/v1/actions/grant {requestId}                            → signed grant (≤ 10 min)
  └─ POST <execution-runtime>/execution/v1/operations {grant, operation}
        verify signature, expiry and operation digest → use grant once → run in the
        (org, employee, agent, thread) workspace → store evidence → {result, output, artifacts}
```

## Operations

| Operation        | Governed by             | Tool          | Notes                                                                                                                                                |
| ---------------- | ----------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.checkout`   | `repository.read`       | `repository`  | Shallow clone of a branch or tag into a new workspace subdirectory; configured repository only                                                       |
| `git.status`     | `repository.read`       | `repository`  | `git status --porcelain=v1 --branch`                                                                                                                 |
| `file.read`      | `repository.read`       | `repository`  | Text only, capped at 256 KiB; the path must stay inside the workspace after resolving symlinks                                                       |
| `playwright.run` | `qa.execute_playwright` | `browser`     | Runs the project's installed `@playwright/test` with a JSON reporter against the configured QA origin; requires approval                             |
| `file.write`     | `repository.write`      | `code-editor` | Phase G. Inline UTF-8 content, at most 128 KiB; the deepest existing ancestor must resolve inside the workspace, and links are never written through |
| `command`        | `workspace.command`     | `build`       | Phase G. Only `npm run <script>` for the agent's configured `projectScripts`; network `NONE`; container provider only                                |

## Local provider guarantees

| Enforced                                                                                    | Not enforced (documented, never assumed) |
| ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Workspace path confinement (lexically, then after resolving symlinks)                       | CPU and memory limits                    |
| Argument lists, never a shell                                                               | Process-count limit                      |
| Scrubbed environment: private HOME and TMP, empty git config, no inherited secrets          | Network egress allow-list                |
| Wall-clock timeout that kills the process tree; capped output                               |                                          |
| git hooks, credential helpers and templates disabled; `file://` repositories off by default |                                          |

Because of the right-hand column, the local provider reports `isolation: 'local'`. Agents
whose manifest requires `sandboxed` (the QA Engineer does) are refused
(`ISOLATION_UNAVAILABLE`) unless `EXECUTION_ALLOW_UNSANDBOXED=true` is set. Set that only for
development.

## Container provider (Phase G)

`EXECUTION_PROVIDER=container` selects `ContainerExecutionProvider` (`isolation: sandboxed`,
[ADR 0015](adr/0015-frontend-engineer-and-sandboxed-execution.md)).

| Where                    | Operations                                              | Enforced                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container (`docker run`) | `command`, `playwright.run` (all repository code)       | No capabilities, `no-new-privileges`, read-only root filesystem with a private `/tmp`, the grant's CPU, memory and process limits, `--pull never`, the workspace as the only mount, only the variables the provider sets, `--network none` for grants without hosts, an egress proxy for grants with hosts, and timeouts that remove the container |
| Host (local provider)    | `git.checkout`, `git.status`, `file.read`, `file.write` | Everything in the local provider table; these run no repository code, but they are not network-isolated                                                                                                                                                                                                                                            |

Executables are allow-listed (`npm` by default). Images must already be present.

### Egress proxy

Grants that need network (Playwright against a QA environment) run behind an egress proxy
([ADR 0016](adr/0016-egress-proxy.md)):

- The sandbox joins a private `--internal` network created for the operation, so it has no
  route out.
- The network's only other member is a locked-down proxy container
  (`sandbox/egress-proxy.mjs`). It forwards `CONNECT` tunnels and plain HTTP to the grant's
  exact hostnames and nothing else.
- The proxy resolves names itself and refuses loopback, link-local (cloud metadata),
  unspecified and multicast addresses.
- Clients reach it through `HTTP_PROXY` and `HTTPS_PROXY`. A client that ignores them cannot
  connect at all.
- Every decision is stored as an `egress.log` artifact, and blocked hosts are reported to the
  model.
- The sandbox, proxy and network are removed after each operation.

With `EXECUTION_EGRESS_PROXY=false`, such grants are refused (`EGRESS_CONTROL_UNAVAILABLE`)
unless `EXECUTION_ALLOW_UNRESTRICTED_EGRESS=true` runs them on the bridge network with no
allow-list.

## Configuration

| Variable                                | Default                   | Purpose                                                                                                  |
| --------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EXECUTION_GRANT_VERIFICATION_KEY`      | required                  | Control-plane public key (base64 SPKI from `GET /api/manifest-key`)                                      |
| `EXECUTION_RUNTIME_HOST` / `_PORT`      | `127.0.0.1` / `4500`      | Listen address; keep it on loopback or behind mTLS                                                       |
| `EXECUTION_RUNTIME_STATE_DIR`           | `.data/execution-runtime` | Workspaces, scratch, artifacts and state database                                                        |
| `EXECUTION_ALLOW_UNSANDBOXED`           | `false`                   | Accept grants that require a sandbox on the local provider                                               |
| `EXECUTION_ALLOW_FILE_REPOSITORIES`     | `false`                   | Allow `file://` repositories (mirrors and tests)                                                         |
| `EXECUTION_PROVIDER`                    | `local`                   | `local` or `container`                                                                                   |
| `EXECUTION_SANDBOX_IMAGE`               | required for `container`  | Image for project scripts, for example `node:22-bookworm-slim`                                           |
| `EXECUTION_PLAYWRIGHT_IMAGE`            | the sandbox image         | Image with Playwright browsers for `playwright.run`                                                      |
| `EXECUTION_EGRESS_PROXY`                | `true`                    | Container provider: enforce grant host allow-lists with the egress proxy                                 |
| `EXECUTION_EGRESS_PROXY_IMAGE`          | the sandbox image         | Image that runs the egress proxy; it needs `node`                                                        |
| `EXECUTION_EGRESS_PROXY_DIR`            | the package's `sandbox/`  | Directory containing `egress-proxy.mjs`                                                                  |
| `EXECUTION_ALLOW_UNRESTRICTED_EGRESS`   | `false`                   | Without the proxy: run grants that need network on the bridge network (no allow-list)                    |
| `EXECUTION_RUNTIME_URL` (agent runtime) | unset                     | When set, the agent runtime offers the workspace tools (`repository`, `browser`, `code-editor`, `build`) |

```bash
npm run dev:execution   # execution runtime
npm run dev:runtime     # agent runtime with EXECUTION_RUNTIME_URL=http://127.0.0.1:4500
```

## Limitations

- Egress is allow-listed by hostname only: any port on an allowed host is reachable, and TLS
  is not intercepted. Real Chromium through the proxy is not covered by tests yet.
- There is no dependency installation. Scripts run offline, so `node_modules` (including
  `@playwright/test`) must come with the checkout or the image.
- Only public HTTPS repositories work; checkouts are of branches or tags, not commit SHAs.
- Shell commands are never granted; only allow-listed `npm run` scripts are.
- If the execution runtime crashes mid-operation, the grant stays `RUNNING` and can't be
  reused. The action must be requested again.
