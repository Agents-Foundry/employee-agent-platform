# ADR 0031: Secret broker, credential broker and private repository checkout

- Status: Accepted
- Date: 2026-10-01

## Context

Agents could check out only public repositories. Connector secrets were resolved from an
operator file by a synchronous helper, with no managed-vault path. Giving an agent a private
repository must not give a token to the model, the agent runtime, an event, an audit record, a
report, an artifact, a workspace or a database table.

## Decision

### Secret broker

1. **One way to read a secret.** `SecretBroker.resolve(organizationId, reference)` is the only
   path from a `secret://<name>` reference to a value. PostgreSQL stores references only.
   Connectors (Jira, GitHub pull requests) and repository credentials both use it.
2. **Values are wrapped.** A resolved secret is a `SecretValue`: printing, serializing or
   inspecting it yields `[REDACTED]`. The value is read with `reveal()` at the single point
   that hands it to a provider.
3. **Providers are a boundary** (`SecretProvider`), selected by `SECRET_PROVIDER`:
   - `development` (default): the operator file at `CONNECTOR_SECRETS_PATH`. Not for production.
   - `vault`: HashiCorp Vault KV version 2, or a compatible KMS-backed store, at
     `<mount>/data/<prefix>/<organizationId>/<name>`, field `value`. The API authenticates with
     a short-lived token read from `VAULT_TOKEN_PATH` on each use, as a Vault agent or workload
     identity supplies it. Redirects are refused.
4. **Fail closed.** A missing secret, an invalid reference or a provider failure is
   `SECRET_UNRESOLVED`. Errors never carry provider responses.

### Credential broker

5. **Source-control connections** (`organization_source_control_connections`): provider
   (`github` or `bitbucket`), git host, credential mode, a secret reference and the
   repositories checkouts may authenticate to. Administrators create and disable them.
6. **A lease is issued with the grant.** When the Action Gateway issues the signed execution
   grant for a `git.checkout` of a repository an active connection allows, it creates a
   `repository_credential_leases` row in the same transaction and names it in the grant
   (`credential: { leaseId, provider, gitHost }`). By then the gateway has authorized the
   organization, the agent runtime's workload identity, its active lease on the run, the
   employee, the agent, the signed manifest, the exact repository, ref and operation. The
   lease records all of them. It holds no credential. A repository no connection allows is
   checked out anonymously, as before.
7. **Only an execution runtime redeems.** Runtime identities have a role. `agent` runtimes
   claim runs and request grants; `execution` runtimes can only redeem and release leases.
   `POST /runtime/v1/credentials/redeem` requires the execution role and the complete signed
   grant, and checks again that:
   - the control plane signed the grant, it is unexpired, and it names this lease;
   - the runtime serves the grant's organization;
   - the lease is `ISSUED`, unexpired, and matches the grant's id, request, operation digest,
     run, employee and agent;
   - the run is `RUNNING` with an active run lease;
   - the connection is still active and still allows the repository.

   The lease becomes `REDEEMED` in that transaction. Only then is the secret resolved and the
   credential returned, to that runtime only.

8. **Leases are:**
   - tenant-scoped: forced row-level security, and the organization comes from the signed
     grant, never from the request;
   - repository- and operation-scoped: bound to one repository, ref and operation digest;
   - short-lived: five minutes, and never beyond the grant;
   - one-use: a second redemption is refused and revokes the lease;
   - revocable: by an administrator, when the run stops, when the connection is disabled
     (checked at redemption), or by expiry;
   - non-transferable: only the control-plane-signed grant redeems it, only an execution
     identity may, and only the runtime that redeemed it may release it.
9. **Issuers** turn a connection's secret into a credential:
   - `static_token`: a read-only token from the secret store (GitHub fine-grained token,
     Bitbucket repository access token).
   - `github_app`: the secret is the App's private key. Each redemption mints an installation
     token restricted to the one repository and `contents: read`, refuses a broader token, and
     revokes it when the lease ends. GitHub expires it within an hour regardless.

### Private checkout

10. **The execution runtime redeems, uses and releases.** A grant that names a lease is refused
    unless the operation is `git.checkout` and the runtime has its own identity
    (`EXECUTION_CONTROL_PLANE_URL`, `EXECUTION_RUNTIME_ID`, `EXECUTION_RUNTIME_KEY_PATH`). It
    never falls back to an anonymous clone. The lease is released when the checkout ends,
    whatever the outcome.
11. **The credential never touches disk.** It is passed to `git` as an `Authorization` header
    scoped to the exact repository URL through the child process environment
    (`GIT_CONFIG_*`): not in the URL, a config file, a credential helper or the command line.
    After the clone the repository's config is checked, and the checkout discarded if anything
    of the credential is in it. Output, errors and log artifacts are redacted.
12. **Egress.** Every HTTPS checkout leaves through the ADR 0016 egress proxy, run in-process,
    which forwards only to the grant's hosts. Redirects are not followed. Only the `https`
    transport is allowed.
13. **Submodules are never fetched**, and the credential is never offered to them. Submodule
    authorization needs its own model.
14. **Nothing partial survives.** A failed, timed-out or cancelled clone is removed. A
    credentialed checkout is recorded before redemption, so after a crash the next start
    removes the partial checkout, releases the lease and closes the grant.

## Consequences

- The agent runtime and the model see a lease id at most. The credential exists in the control
  plane's memory during redemption, in the response to the execution runtime, and in that
  runtime's memory and the `git` process environment during one clone.
- With `static_token`, the token's own scope is the provider-side limit: revoking a lease
  stops further redemptions but cannot withdraw a token already handed out. `github_app`
  tokens are withdrawn at the provider.
- Provider-side revocation is remembered in the memory of the instance that redeemed. After a
  restart, a GitHub App token is no longer withdrawn early; it expires within the hour.
- Every HTTPS checkout, anonymous or not, now goes through the egress proxy.
- Repositories with submodules are checked out without them.
- Connector secrets are now resolved through the broker inside the dispatch transaction, so a
  slow vault holds that transaction open for up to the provider timeout (5 seconds).
- Each execution runtime needs a registered identity to perform authenticated checkouts.
