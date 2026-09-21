# Security model

## Foundation invariants

- Raw LLM, Jira, Bitbucket, or browser credentials are never stored in application tables.
- Every external write and browser execution request passes through the policy engine.
- Approval requires an admin actor; self-approval is forbidden by the intended production authorization layer.
- The QA employee agent cannot deploy to production or change organization permissions.
- Conversation content is organization-scoped and centrally persisted.
- Audit events are appended for workflow mutations.
- Request payloads are size-limited and schema-validated.
- The API disables framework disclosure, sets security headers, restricts origins, and rate-limits requests.

## POC authentication warning

Explicit actor headers now work only in opt-in local demo mode. Google mode requires a server-side Workspace login and an HttpOnly application session on every business route. Roles and organizations come from operator-managed membership records; browser headers are ignored. See [Google Workspace security and setup](google-workspace.md).

Demo headers remain public and forgeable, and demo mode cannot run with NODE_ENV=production. Google sign-in does not complete the remaining production work: database-level tenant isolation, vaults, and key rotation are still pending. See [provisioning](provisioning.md) for manifest-key storage, trust, and rotation limitations.

## Key management

`llm_key_bindings.secret_ref` is an opaque pointer such as a cloud secret-manager resource name. Provider keys must be created, rotated, and read only through the vault integration. The API must never return secret material to either Angular application.
