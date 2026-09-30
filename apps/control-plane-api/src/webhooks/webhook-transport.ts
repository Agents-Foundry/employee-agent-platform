import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Outbound HTTP for alert webhooks (ADR 0024). Endpoints are organization input, so every
 * request is limited: HTTPS on the default port, no redirects, a hard deadline, the response
 * body discarded unread, and every address the host resolves to checked at connect time.
 */

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped addresses (::ffff:0:0/96) are checked against the IPv4 rules by BlockList
  // itself; a rule for the whole range would block every IPv4 address.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/**
 * Whether an address is private, loopback, link-local, shared, reserved, multicast or a
 * translation of one; anything not a valid address counts as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const failure = (code: string) => Object.assign(new Error(code), { code });

/** Resolves like the default lookup, but refuses a host if any of its addresses is blocked. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address)))
      return callback(failure('WEBHOOK_ADDRESS_BLOCKED'), '', 0);
    if (options.all)
      return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

export type WebhookSend = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number }>;

/** A stable error code for a failed attempt; raw error messages are never stored or logged. */
export function webhookErrorCode(error: unknown): string {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  const name = String((error as { name?: unknown } | null)?.name ?? '');
  if (code.startsWith('WEBHOOK_')) return code;
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR')
    return 'WEBHOOK_TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'WEBHOOK_DNS_FAILED';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code.includes('CERT') ||
    code.startsWith('UNABLE_TO_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  )
    return 'WEBHOOK_TLS_FAILED';
  return 'WEBHOOK_CONNECTION_FAILED';
}

/**
 * POSTs a delivery and reports the response status. With `allowPrivateNetwork` (local testing
 * only) plain HTTP and private addresses are allowed.
 */
export function webhookTransport(options: { allowPrivateNetwork: boolean }): WebhookSend {
  return (url, headers, body, timeoutMs) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const secure = target.protocol === 'https:';
      if (!secure && !options.allowPrivateNetwork) {
        reject(failure('WEBHOOK_URL_INVALID'));
        return;
      }
      // An address literal is connected to without a lookup, so it is checked here.
      const literal = target.hostname.replace(/^\[|\]$/g, '');
      if (!options.allowPrivateNetwork && isIP(literal) !== 0 && isBlockedAddress(literal)) {
        reject(failure('WEBHOOK_ADDRESS_BLOCKED'));
        return;
      }
      const request = (secure ? https : http).request(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
          agent: false,
          signal: AbortSignal.timeout(timeoutMs),
          ...(options.allowPrivateNetwork ? {} : { lookup: guardedLookup }),
        },
        (response) => {
          resolve({ status: response.statusCode ?? 0 });
          // The body is never read: nothing a receiver returns is stored.
          response.destroy();
        },
      );
      request.on('error', reject);
      request.end(body);
    });
}
