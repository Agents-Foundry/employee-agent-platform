import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The directory shipped with this package that holds `egress-proxy.mjs`, if present. */
export function defaultEgressProxyDirectory(): string | null {
  // src/providers/ in development, dist/apps/execution-runtime/src/providers/ when built.
  for (const relative of ['../../sandbox/', '../../../../../sandbox/']) {
    const directory = fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]$/, '');
    if (existsSync(join(directory, 'egress-proxy.mjs'))) return directory;
  }
  return null;
}

/** Test seams for the host egress proxy; production uses the proxy's own defaults. */
export interface EgressOverrides {
  lookup?: (host: string) => Promise<string[]>;
  isBlocked?: (address: string) => boolean;
  portFor?: (host: string, port: number) => number;
}

export interface LocalEgressProxy {
  /** `http://127.0.0.1:<port>`, for `http.proxy`. */
  url: string;
  /** Hosts the proxy refused, in order. */
  denied: string[];
  close(): Promise<void>;
}

/**
 * The ADR 0016 egress proxy, run in-process on loopback for operations the host performs
 * (`git.checkout`). It forwards only to the grant's allowed hosts, resolves names itself and
 * refuses loopback, link-local and other internal addresses, so a redirect or a rewritten URL
 * cannot reach anything else.
 */
export async function startLocalEgressProxy(
  allowedHosts: readonly string[],
  overrides: EgressOverrides = {},
): Promise<LocalEgressProxy> {
  const directory = defaultEgressProxyDirectory();
  if (!directory) throw new Error('EXECUTION_EGRESS_PROXY_NOT_FOUND');
  const module = (await import(
    pathToFileURL(join(directory, 'egress-proxy.mjs')).href
  )) as typeof import('../../sandbox/egress-proxy.mjs');
  const denied: string[] = [];
  const server = module.createEgressProxy({
    allowedHosts: [...allowedHosts],
    log: (entry) => {
      if (entry['decision'] === 'DENY') denied.push(String(entry['host']));
    },
    ...(overrides.lookup ? { lookup: overrides.lookup } : {}),
    ...(overrides.isBlocked ? { isBlocked: overrides.isBlocked } : {}),
    ...(overrides.portFor ? { portFor: overrides.portFor } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    denied,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
