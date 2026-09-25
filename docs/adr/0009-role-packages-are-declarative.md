# ADR 0009: Role packages are declarative expertise

- Status: Accepted
- Date: 2026-09-23

## Context

The platform must support many employee roles without a runtime per role.

## Decision

A role package (for example `qa-engineer-agent`) contains only declarative expertise: the agent
definition, persona, prompts, responsibilities, skills, workflows, required tools and
connectors, default policy and evaluations. The generic runtime interprets it. The runtime,
control plane and execution runtime must not branch on role identity (`if role === 'qa'`);
role behaviour belongs in manifests, skills and workflows. Organizational job roles never grant
application security permissions.

## Consequences

- Phase A's QA compatibility adapter (`apps/control-plane-api/src/agents/manifest-v2.ts`) is a
  blueprint-to-manifest mapping, not runtime behaviour. The catalog replaces it in Phase B.
- The Frontend Engineer role (Phase G) is the acceptance test for this ADR.
