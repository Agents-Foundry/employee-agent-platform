# ADR 0007: Separate execution runtime

- Status: Accepted (implementation in Phase E)
- Date: 2026-09-23

## Context

Shell, git, filesystem, browser and Playwright execution must be isolated with resource,
filesystem and network limits, and must be portable across hosting providers.

## Decision

Dangerous work runs in an execution runtime behind an `ExecutionProvider` interface
(`LocalExecutionProvider` first; Docker, Kubernetes and hosted sandboxes later). The agent
runtime requests execution; it does not host it. Workspaces are owned by
(organization, employee, agent, thread). If a workspace with uncommitted work is lost, the
runtime fails explicitly instead of silently recreating it. Phase A defines the `Workspace`
and `ExecutionRequest`/`ExecutionResult` contracts only.

## Consequences

- Neither the control-plane API nor the agent runtime spawns browsers or shells directly.
- Evidence capture belongs to the execution runtime, and the evidence is stored as artifacts.
