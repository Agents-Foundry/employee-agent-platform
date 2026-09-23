# ADR 0002: Separate the agent runtime from the control plane

- Status: Accepted
- Date: 2026-09-23

## Context

`employee-agent-platform` is a synchronous Express/SQLite control plane. Agent work (model loops,
tool calls, MCP subprocesses, git working copies, browsers) is long-running, resource-heavy and
security-sensitive. Running it inside the API process would couple the availability, tenancy
and privilege of both concerns.

## Decision

The control plane orchestrates; a separate agent runtime executes. The control plane owns
identity, organizations, catalog, provisioning, signed manifests, policy, approvals, audit and
run records. The runtime owns reasoning loops, context, model access, skills, tools and MCP
clients. They communicate only through the versioned protocol `agents-foundry/runtime/v1`
(`packages/contracts/src/runtime/v1`). The runtime starts as contracts in this repository and
moves to the `agent-runtime` repository once a working kernel exists (Phase C).

## Consequences

- The Express process never spawns shells, browsers, MCP servers or model loops.
- Runs are asynchronous and resumable; the control plane stores state, not execution.
- A workload identity for the runtime is required before any runtime-ingestion endpoint is exposed.
