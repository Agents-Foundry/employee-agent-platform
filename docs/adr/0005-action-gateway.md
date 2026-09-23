# ADR 0005: Action Gateway for governed external actions

- Status: Accepted (implementation in Phase D)
- Date: 2026-09-23

## Context

MCP servers and connectors expose tools that can write to external systems. Letting an agent
call them directly would bypass organization policy, approval and audit.

## Decision

Governed operations are requested as semantic actions (`jira.issue.create`,
`repository.pull_request.create`, …) through a control-plane Action Gateway. It performs
authorization, deterministic policy evaluation, approval, secret resolution and audit before it
dispatches to a connector or the execution runtime. Results are `APPROVED`, `REQUIRES_APPROVAL`
or `DENIED`, with remediation. An exposed MCP tool never implies permission. LLMs never make the
final authorization decision.

## Consequences

- Connectors contain no organization authorization logic.
- If policy evaluation is unavailable, governed writes are denied.
- Phase A records approval links on runs so the gateway can later pause and resume them.
