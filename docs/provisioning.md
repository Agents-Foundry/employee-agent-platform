# Blueprint provisioning and signed manifests

This selectively ports provisioning and manifest concepts from the earlier milestone-1 prototype into the existing Express/SQLite and Angular applications. Its file-backed server and browser shells are not used.

## Version and policy

QA blueprint `engineering.qa-engineer` version `1.1.0` uses the foundation's existing policy decisions. Unlike prototype 1.0.0, every Playwright run requires admin approval. Production deployment remains denied. Clients cannot supply capabilities or override permissions. The server validates the exact blueprint version, all required answers, allowed selections, and HTTP(S) URLs without embedded credentials.

## Persistence and lifecycle

Two additive SQLite tables store provisioning requests and immutable manifests. Approval atomically records its decision, creates the assigned agent and signed manifest, and appends audit events. Rejection creates no agent. Repeated decisions return 409 and self decisions return 403. The original seeded demo agent and existing conversations are preserved.

Lifecycle events are `provisioning.requested`, `provisioning.approved`, `provisioning.rejected`, and `agent.manifest.issued`, using the existing audit table. The admin view displays the latest 100 provisioning events for the demo organization.

## Manifest format and signing keys

Ed25519 signs UTF-8 canonical JSON: object keys sorted by JavaScript ordinal ordering, array ordering unchanged. The immutable payload covers organization/employee/agent IDs, blueprint version, questionnaire answers, model preferences, fixed capabilities, policy version, and issuance time. The key ID is the SHA-256 fingerprint of the public SPKI DER bytes; signatures and public keys use standard Base64.

File-backed databases use a private key beside the database at `<DATABASE_PATH>.signing-key.pem`. Override with `MANIFEST_SIGNING_KEY_PATH`. Creation is exclusive with POSIX mode 0600; on Windows, directory ACLs govern access. Memory-only test databases use ephemeral keys. Back up the database and key together. Do not delete or replace the key: existing manifests will fail verification. Corrupt or non-Ed25519 key files fail startup. Rotation and revocation are not implemented yet. Private keys are never returned by the API and are ignored by Git.

The employee app obtains the public key from the local API, validates its fingerprint and the manifest signature using Web Crypto, and checks organization, employee, and agent ownership before selecting the agent. Unsupported Ed25519 browsers fail closed. The API also verifies stored signatures before returning a manifest or opening a conversation for a provisioned agent.

## Local POC authentication boundary

This is not production identity or multi-tenant authorization. The new routes require explicit demo headers: `x-organization-id: org_agents_foundry`, with `x-actor-id: employee_qa_demo` / `x-actor-role: EMPLOYEE`, or `x-actor-id: admin_demo` / `x-actor-role: ADMIN`. These are public, forgeable demo identities. OIDC, verified tenant claims, transport security, pinned/managed verification keys, revocation, and vault-backed signing must precede any shared deployment. Existing foundation routes retain their documented demo behavior.

Fetching a key from the same local API protects against payload alteration, not compromise of that API or its transport. Neither this verification nor provisioning launches an autonomous runtime. The existing QA execution approval gate remains in force.

## API

| Method     | Route                            | Actor                                                  |
| ---------- | -------------------------------- | ------------------------------------------------------ |
| GET        | `/api/blueprints`                | Employee or admin                                      |
| GET        | `/api/manifest-key`              | Employee or admin; public key only                     |
| GET / POST | `/api/provisioning`              | Employee sees own requests and submits; admin may list |
| POST       | `/api/provisioning/:id/decision` | Admin; APPROVED/REJECTED and a reason                  |
| GET        | `/api/agents/:id/manifest`       | Assigned employee or organization admin                |
| GET        | `/api/lifecycle-events`          | Admin                                                  |

No raw credentials belong in questionnaire answers or model identifiers. Provider/model availability and credential connectivity are not validated in this milestone.
