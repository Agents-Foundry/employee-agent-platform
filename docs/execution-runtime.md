# Execution runtime (`apps/execution-runtime`)

The execution runtime is a separate process that runs workspace operations for agent runs:
repository checkout, git status, file reads and Playwright tests. It acts only on
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

| Operation               | Governed by             | Tool         | Notes                                                                                                                    |
| ----------------------- | ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `git.checkout`          | `repository.read`       | `repository` | Shallow clone of a branch or tag into a new workspace subdirectory; configured repository only                           |
| `git.status`            | `repository.read`       | `repository` | `git status --porcelain=v1 --branch`                                                                                     |
| `file.read`             | `repository.read`       | `repository` | Text only, capped at 256 KiB; the path must stay inside the workspace after resolving symlinks                           |
| `playwright.run`        | `qa.execute_playwright` | `browser`    | Runs the project's installed `@playwright/test` with a JSON reporter against the configured QA origin; requires approval |
| `command`, `file.write` | —                       | —            | In the contract but never granted in Phase E (`OPERATION_NOT_ALLOWED`); the local provider refuses them                  |

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

## Configuration

| Variable                                | Default                   | Purpose                                                                 |
| --------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `EXECUTION_GRANT_VERIFICATION_KEY`      | required                  | Control-plane public key (base64 SPKI from `GET /api/manifest-key`)     |
| `EXECUTION_RUNTIME_HOST` / `_PORT`      | `127.0.0.1` / `4500`      | Listen address; keep it on loopback or behind mTLS                      |
| `EXECUTION_RUNTIME_STATE_DIR`           | `.data/execution-runtime` | Workspaces, scratch, artifacts and state database                       |
| `EXECUTION_ALLOW_UNSANDBOXED`           | `false`                   | Accept grants that require a sandbox on the local provider              |
| `EXECUTION_ALLOW_FILE_REPOSITORIES`     | `false`                   | Allow `file://` repositories (mirrors and tests)                        |
| `EXECUTION_RUNTIME_URL` (agent runtime) | unset                     | When set, the agent runtime offers the `repository` and `browser` tools |

```bash
npm run dev:execution   # execution runtime
npm run dev:runtime     # agent runtime with EXECUTION_RUNTIME_URL=http://127.0.0.1:4500
```

## Limitations (Phase E)

- There is no sandboxing provider yet (containers or micro-VMs with egress control).
- There is no dependency installation, so projects must already contain `@playwright/test`.
- Only public HTTPS repositories work; checkouts are of branches or tags, not commit SHAs.
- Shell commands and file writes are not exposed to agents.
- If the execution runtime crashes mid-operation, the grant stays `RUNNING` and can't be
  reused. The action must be requested again.
