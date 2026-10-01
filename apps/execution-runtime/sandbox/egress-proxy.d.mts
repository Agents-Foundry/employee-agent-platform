import type { Server } from 'node:http';

export interface EgressProxyOptions {
  /** Exact hostnames the grant allows. */
  allowedHosts: string[];
  /** One JSON-serializable decision per connection attempt. Default: a line on stdout. */
  log?: (entry: Record<string, unknown>) => void;
  /** Resolve a hostname to its addresses. Default: the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Addresses no grant may reach. Default: {@link isBlockedAddress}. */
  isBlocked?: (address: string) => boolean;
  /** Tests only: the local port standing in for an allowed host's port. */
  portFor?: (host: string, port: number) => number;
}

export function normalizeHost(host: string): string;
export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean;
export function isBlockedAddress(address: string): boolean;
export function createEgressProxy(options: EgressProxyOptions): Server;
