# Agent Manifest v2

`apiVersion: agents-foundry/v2`, `kind: AgentManifest` (ADR 0004). A v2 manifest is the fully
resolved, signed runtime configuration of one employee-assigned agent. Types live in
`packages/contracts/src/manifest-v2.ts`, and the strict schema is `manifestV2PayloadSchema`.

## Status

- Issuance: implemented behind `AGENT_MANIFEST_V2_ISSUANCE_ENABLED=true` (default **off**).
  Admin-created agents and approved provisioning requests both use it.
- Verification: the server (`getManifest`) and the desktop (`verifyManifest`) accept v1 and v2.
  Unknown versions fail closed.
- Resolution: `apps/control-plane-api/src/agents/manifest-v2.ts` resolves a catalog bundle and
  validated answers into v2 sections, with no role-specific code. Connectors and MCP servers
  follow the blueprint's declared answer mappings. See [agent catalog](agent-catalog.md).
- Runtime use: `run.submit` accepts only v2 manifests. No runtime consumes them yet.

## Shape

```yaml
apiVersion: agents-foundry/v2
kind: AgentManifest
metadata: { manifestId, agentId, organizationId, employeeId, issuedAt,
            blueprint: { id, version, digest }, installationId? }   # digest and installationId since Phase B
identity: { name, role: qa-engineer, department: Engineering }
persona: { profile: qa-engineer-default }
runtime: { profile: standard-agent, isolation: sandboxed }
model: { profile: qa-default, provider, model, credentialMode: ORGANIZATION_MANAGED }
skills: [{ id: story-analysis, version: 1.0.0 }, …]
tools: [repository, browser, artifact]
connectors: [{ id: jira, capabilities: [issueTracker.read] }, { id: bitbucket, capabilities: [sourceControl.read] }]
mcp: [playwright]
memory: { profile: project-employee-memory }
knowledge: { sources: [assigned-repositories, issue-tracker-project] }
policies: { profile: qa-standard, policyVersion: foundation-approval-v1, capabilities: [{ action, outcome }] }
workflows: [validate-story, sanity-test, regression-test, post-release-validation]
evaluations: { suite: qa-engineer-v1 }
configuration: { projectName, repositoryUrl, qaUrl, … }   # resolved installation answers
conversationSync: REQUIRED
```

Connectors list **read** capabilities only. Governed writes (for example `jira.issue.create`)
are decided by `policies.capabilities` and, from Phase D, by the Action Gateway. A connector
listed in the manifest never grants permission by itself.

## Signing

Signing is unchanged from v1: Ed25519 over canonical JSON (ordinally sorted keys, array order
preserved), with the same persistent key and SHA-256 SPKI key id. `apiVersion` is part of the
signed bytes, so a v1 manifest cannot be relabelled as v2.

## Invariants

- Existing v1 manifests are never re-signed, migrated or mutated. They stay valid.
- A new blueprint version produces a new manifest for a new agent instance. It never edits an
  active one.
- `getManifest` rejects a stored manifest whose structure is invalid, whose signature fails, or
  whose signed organization, employee or agent differs from the row it is stored under.
- Secrets never appear in a manifest. `credentialMode` states where credentials come from, not
  what they are.

## Rollback

Turn the flag off to go back to issuing v1. Keep the v2-aware verifier deployed while any
issued v2 manifest is still active.
