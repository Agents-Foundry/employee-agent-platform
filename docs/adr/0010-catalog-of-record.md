# ADR 0010: Immutable catalog of record pinned by digest

- Status: Accepted
- Date: 2026-09-25

## Context

Blueprints, skills, tools and workflows ship as data. Installations and signed manifests refer
to a blueprint version. If a released version's content could change in place, the "same"
version would mean different things over time, and an installation could silently change
what new agents receive.

## Decision

At startup the control plane validates the shipped catalog. It resolves each blueprint version
into a bundle (the blueprint plus the exact skill, tool and workflow versions it pins), hashes
the canonical bundle with SHA-256, and registers it in `catalog_blueprint_versions`. Triggers
make that table append-only. A shipped version whose digest differs from its registered digest
fails startup (`CATALOG_VERSION_MUTATED`). Installations, agents and manifests resolve against
the registered copy, not the shipped files. v2 manifests record the digest. Policy outcomes are
not part of the bundle; they are evaluated from the policy engine at resolution time.

## Consequences

- Changing a released version requires publishing a new version.
- Versions that stop shipping remain resolvable for existing installations.
- A policy change never changes a bundle's identity, and a bundle can never grant itself an outcome.
- Rolling back to code that shipped a *different* body for an already registered version fails
  startup instead of drifting silently.
