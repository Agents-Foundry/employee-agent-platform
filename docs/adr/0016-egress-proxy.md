# ADR 0016: Grant host allow-lists enforced by an egress proxy

- Status: Accepted
- Date: 2026-09-28

## Context

Execution grants carry a network limit: `NONE`, or `ALLOW_LIST` with the exact hostnames an
operation may reach (ADR 0013). The container provider (ADR 0015) could enforce `NONE`
(`--network none`) but not an allow-list. Grants that need network, such as QA Playwright runs
against a QA environment, were therefore refused (`EGRESS_CONTROL_UNAVAILABLE`) unless the
operator set `EXECUTION_ALLOW_UNRESTRICTED_EGRESS=true` and gave them open network access.

## Decision

1. **A private network per operation.** For an `ALLOW_LIST` grant, the container provider
   creates an `--internal` Docker network for that one operation. The sandbox joins only that
   network, so it has no route out.
2. **An egress proxy container** is the network's only other member. It is also on the
   default bridge network, which makes it the only way out.
   - It runs `apps/execution-runtime/sandbox/egress-proxy.mjs`, a dependency-free Node script,
     mounted read-only into the sandbox image.
   - It is as locked down as the sandbox: no capabilities, `no-new-privileges`, a read-only
     root, 128 MiB of memory, 64 processes and half a CPU.
   - The grant's hosts are its whole configuration. Hosts are validated before they reach it.
3. **What the proxy forwards.**
   - `CONNECT` tunnels (HTTPS and other TLS) and plain HTTP in absolute form. WebSocket
     upgrades over plain HTTP are refused.
   - Only to exact hostnames in the grant: no wildcards or suffixes. IP literals must be named
     by the grant too.
   - The proxy resolves names itself and connects to the resolved address. It refuses names
     that resolve to loopback, link-local (including cloud metadata), unspecified or multicast
     addresses, even when the name is allowed.
   - TLS is never intercepted, so enforcement is by destination hostname, not by URL.
4. **Clients find the proxy** through `HTTP_PROXY`, `HTTPS_PROXY` (both cases) and
   `NODE_USE_ENV_PROXY=1`, which npm, git, curl and Node's `fetch` honour. A client that ignores
   them cannot connect at all: the network has no other route. Enforcement never depends on
   the client cooperating.
5. **Evidence.** Each decision (allow or deny, method, host and port, never paths or queries)
   is logged and stored as an `egress.log` artifact. Blocked destinations are appended to the
   model's output so the agent can explain the failure.
6. **Cleanup and failure.** The sandbox, proxy and network are removed after every operation,
   including timeouts. If the network or proxy cannot be set up, the operation fails
   (`EGRESS_PROXY_UNAVAILABLE`) before any repository code runs.
7. **Configuration.** The proxy is on by default for the container provider.
   - `EXECUTION_EGRESS_PROXY=false` restores the Phase G behaviour: refuse, or with
     `EXECUTION_ALLOW_UNRESTRICTED_EGRESS=true`, allow everything.
   - `EXECUTION_EGRESS_PROXY_IMAGE` sets the proxy's image; it needs `node`.
   - `EXECUTION_EGRESS_PROXY_DIR` sets where the proxy script is.

## Consequences

- QA Playwright runs on the container provider reach their QA environment and nothing else,
  without any override.
- Hostname allow-listing allows every port on an allowed host, because grants name hosts,
  not ports.
- Without TLS interception, a client can reach other names served by an allowed host's
  address, for example through CDN domain fronting.
- Private addresses are reachable when an allowed name resolves to them. That is how internal
  QA environments work.
- Git checkout and file operations still run on the host and are not network-isolated
  (ADR 0015).
- The integration tests use Node's `fetch` and a stand-in Playwright CLI. An opt-in check
  (`AF_PLAYWRIGHT_CHECK=1`, `test/playwright-egress.spec.ts`) runs real `@playwright/test`
  and Chromium: the page loads through the proxy, and Chromium's request to a host outside
  the grant is refused. It showed that Chromium's page process crashes under 64 processes,
  so `qa.execute_playwright` grants allow 256; other operations keep 64.
