# ADR 0015: Frontend Engineer, sandboxed execution and governed pull requests

- Status: Accepted; egress allow-lists added by ADR 0016, dependency installation by ADR 0017
- Date: 2026-09-26

## Context

ADR 0009 says roles are declarative packages. It names a second role, the Frontend Engineer, as
its acceptance test: if that role needs role-specific platform code, the architecture has
failed. A Frontend Engineer must also do things the QA Engineer never did:

- change files;
- run the project's own scripts;
- propose the result for review.

These are exactly the operations ADR 0013 left ungranted (`file.write`, `command`), and the
pull-request action that ADR 0012's gateway had no connector for. Running repository scripts
also needs real isolation, which the local provider does not offer.

## Decision

1. **The role is data.** `engineering.frontend-engineer@1.0.0` lives in the catalog package:
   - the `implement-ui-change` workflow;
   - four skills;
   - three new tools: `code-editor`, `build` and `source-control`.

   It is sandboxed and uses Jira and GitHub connectors. The agent runtime, execution runtime
   and Action Gateway contain no role logic, and a test scans them for role names. Only the
   documented legacy QA compatibility code in the control plane may name a role.

2. **Workspace writes (`repository.write`, ALLOW, LOW).**
   - A granted `file.write` carries inline UTF-8 content of at most 128 KiB. It replaces the
     never-implemented `contentArtifactId` form.
   - Writes stay inside the workspace. The deepest existing ancestor must resolve inside it
     before any directory is created, and links are never written through.
   - Nothing outside the workspace changes.
3. **Project scripts (`workspace.command`, ALLOW, MEDIUM).**
   - The only grantable command is `npm run <script>`, for scripts in the agent's configured
     `projectScripts`. The default is `build, lint, test`.
   - Grants carry `network: NONE`.
   - The container provider also allow-lists executables (`npm`), and the local provider never
     runs repository code.
4. **Pull requests (`repository.pull_request.create`, REQUIRE_APPROVAL, HIGH)** are a
   control-plane action through a GitHub connector (`sourceControl.write`).
   - **Change set.** The runtime sends only the request: repository, branches, title, body and
     checkout directory. The gateway assembles the change set itself: the latest content of
     each file written by a granted `repository.write` whose step completed, in the run's
     thread.
   - **Approval.** The gateway digests the change set, lists it in the approval summary and
     stores it with the request.
   - **Dispatch.** Dispatch publishes only an identical change set; otherwise it refuses with
     `CHANGE_SET_CHANGED`.
   - **Scope.** The repository must be allowed by the connection and be the agent's configured
     `repositoryUrl`. Head branches must be new `agents-foundry/*` branches.
   - **Publication.** The connector commits through the REST API and opens a **draft** pull
     request. No git credentials exist in any workspace, and nothing is pushed from one.
5. **Sandboxing provider.** `ContainerExecutionProvider` reports `isolation: sandboxed`.
   - Repository code (`command`, `playwright.run`) runs only in containers with:
     - no capabilities and `no-new-privileges`;
     - a read-only root filesystem and a private `/tmp`;
     - the grant's CPU, memory and process limits;
     - `--pull never`;
     - the workspace as the only mount;
     - only the environment the provider sets.
   - Grants without hosts get `--network none`. The provider cannot restrict egress to an
     allow-list, so grants that need network are refused (`EGRESS_CONTROL_UNAVAILABLE`) unless
     the operator sets `EXECUTION_ALLOW_UNRESTRICTED_EGRESS=true`.
   - Git and file operations run on the host through the local provider's confined, hook-free
     implementation. They execute no repository code, but they are not network-isolated.
6. **Migration 011** is additive in effect:
   - GitHub connections: the connection table is rebuilt to widen its CHECK constraint,
     keeping rows, the index and the triggers, with foreign keys checked before commit.
   - `agent_action_requests.change_set`.

## Consequences

- A second role runs end to end on the same platform: read the story, check out, edit, run
  tests in a container, then publish exactly the approved files as a draft pull request.
- QA Playwright runs need network access to the QA environment. On the container provider
  they still need `EXECUTION_ALLOW_UNRESTRICTED_EGRESS=true` until an egress proxy enforces
  allow-lists.
- There is no dependency installation. Scripts run offline, so `node_modules` must come with
  the checkout or a prepared image.
- Pull requests are GitHub-only. Other source-control providers need their own connector.
