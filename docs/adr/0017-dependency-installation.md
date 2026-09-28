# ADR 0017: Governed dependency installation

- Status: Accepted
- Date: 2026-09-28

## Context

Project scripts run with no network access (ADR 0015), so `node_modules` had to come with the
checkout or the sandbox image. Real repositories do not commit `node_modules`, so a Frontend
Engineer could not run a real project's lint, tests or build. Installing packages means
fetching code from the network and, by default, running packages' install scripts. Both need
to be governed.

## Decision

1. **Operation.** `dependencies.install { path, registryUrl }` runs `npm ci` in the project
   directory:
   - exactly the lockfile's versions, each verified against its integrity hash;
   - `--ignore-scripts`, so no package's install scripts run;
   - `--replace-registry-host=always`, so every locked tarball is fetched through
     `registryUrl`, even when the lockfile names another host;
   - no audit or funding calls, bounded retries, and a per-operation npm cache that is
     removed afterwards.

   A `package-lock.json` or `npm-shrinkwrap.json` is required (`LOCKFILE_REQUIRED`).

2. **Only in the sandbox.** The container provider runs installs under the grant's limits
   behind the egress proxy (ADR 0016). The local provider refuses them
   (`OPERATION_NOT_SUPPORTED`) because it cannot confine the network.
3. **Governed action.** Installs are governed by `workspace.dependencies.install` (ALLOW,
   MEDIUM).
   - An install is in scope only when its registry is the HTTPS `packageRegistryUrl` in the
     agent's signed configuration. The admin sets it; the agent cannot. URLs are compared
     without a trailing slash, and credentials, queries and fragments are refused.
   - Without a configured registry, every install is refused.
   - The grant allows only the registry's host, so the proxy blocks every other destination,
     including git and tarball URLs in the lockfile.
4. **Role package.** Frontend Engineer 1.1.0 adds:
   - the `dependencies@1.0.0` tool;
   - `frontend-verification@1.1.0`;
   - `implement-ui-change@1.1.0`, with an install step before verification;
   - the optional `packageRegistryUrl` question.

   It is data only. Version 1.0.0 is unchanged.

## Consequences

- Real projects can be verified: installs go through the proxy to one registry, and later
  scripts run offline against the installed `node_modules`.
- Packages that need their install scripts (for example to build native modules) do not work.
  Scripts that need them fail visibly rather than running unreviewed code.
- The registry is trusted to serve what the lockfile's integrity hashes describe. A mirror
  that proxies the public registry serves public packages; any vetting of packages belongs
  in the mirror.
- Only npm is supported. Other package managers need their own operation.
- Registry credentials (private mirrors) are not supported yet. They would need
  secret-reference handling in the execution runtime.
