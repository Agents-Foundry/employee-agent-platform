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

Milestone 1 uses explicit actor headers only to demonstrate the approval contract locally. It is **not production authentication**. Before any shared deployment, replace these headers with OIDC-issued identity and organization/role claims verified server-side.

## Key management

`llm_key_bindings.secret_ref` is an opaque pointer such as a cloud secret-manager resource name. Provider keys must be created, rotated, and read only through the vault integration. The API must never return secret material to either Angular application.
