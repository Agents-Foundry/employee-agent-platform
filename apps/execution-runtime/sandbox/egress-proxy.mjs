// Agents Foundry egress proxy (ADR 0016). Runs inside its own locked-down container, the only
// route out of a sandbox's internal Docker network, and forwards connections only to the hosts
// the execution grant allows. Dependency-free on purpose: the provider mounts this one file
// read-only into the sandbox image and runs it with `node`.
//
// Supported: HTTPS and other TLS through CONNECT tunnels, and plain HTTP in absolute form.
// Enforcement is by destination hostname; TLS is never intercepted. The proxy resolves every
// name itself and connects to the resolved address, so a sandbox cannot pick the IP, and names
// that resolve to loopback, link-local (cloud metadata), unspecified or multicast addresses
// are refused even when allowed.

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import { isIP, connect } from 'node:net';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Lower-case, without a trailing dot or IPv6 brackets. */
export function normalizeHost(host) {
  return String(host)
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

/** Exact hostname match only: grants name hosts, never wildcards or suffixes. */
export function hostAllowed(host, allowedHosts) {
  const wanted = normalizeHost(host);
  return wanted !== '' && allowedHosts.some((allowed) => normalizeHost(allowed) === wanted);
}

function ipv4Parts(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

/** Addresses no grant may reach: loopback, link-local (cloud metadata), unspecified, multicast. */
export function isBlockedAddress(address) {
  let value = normalizeHost(address);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) value = mapped[1];
  if (isIP(value) === 4) {
    const [a, b] = ipv4Parts(value);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (isIP(value) === 6)
    return (
      value === '::' ||
      value === '::1' ||
      /^fe[89ab]/.test(value) ||
      value.startsWith('ff') ||
      value.startsWith('::ffff:')
    );
  return true;
}

class Refusal extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * @param {{
 *   allowedHosts: string[];
 *   log?: (entry: Record<string, unknown>) => void;
 *   lookup?: (host: string) => Promise<string[]>;
 *   isBlocked?: (address: string) => boolean;
 * }} options
 */
export function createEgressProxy(options) {
  const allowedHosts = options.allowedHosts.map(normalizeHost).filter(Boolean);
  const log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  const lookup =
    options.lookup ??
    (async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address));
  const isBlocked = options.isBlocked ?? isBlockedAddress;

  /** The address to connect to, or a refusal. Every resolved address must be acceptable. */
  async function resolve(host, port) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Refusal(400, 'PORT_INVALID');
    if (!hostAllowed(host, allowedHosts)) throw new Refusal(403, 'HOST_NOT_ALLOWED');
    const name = normalizeHost(host);
    let addresses;
    try {
      addresses = isIP(name) ? [name] : await lookup(name);
    } catch {
      throw new Refusal(502, 'RESOLUTION_FAILED');
    }
    if (addresses.length === 0) throw new Refusal(502, 'RESOLUTION_FAILED');
    if (addresses.some((address) => isBlocked(address)))
      throw new Refusal(403, 'ADDRESS_NOT_ALLOWED');
    return addresses[0];
  }

  function record(method, host, port, decision, reason) {
    log({
      event: 'egress',
      decision,
      method,
      host: normalizeHost(host).slice(0, 253),
      port,
      ...(reason ? { reason } : {}),
    });
  }

  const server = http.createServer(async (request, response) => {
    let target;
    try {
      target = new URL(request.url ?? '');
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
      response.end('This is an egress proxy; send absolute-form requests.\n');
      return;
    }
    const port = Number(target.port || 80);
    if (target.protocol !== 'http:') {
      record('HTTP', target.hostname, port, 'DENY', 'SCHEME_NOT_SUPPORTED');
      response.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
      response.end('Only http: requests are forwarded; use CONNECT for TLS.\n');
      return;
    }
    let address;
    try {
      address = await resolve(target.hostname, port);
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal(502, 'PROXY_ERROR');
      record('HTTP', target.hostname, port, 'DENY', refusal.reason);
      response.writeHead(refusal.status, { 'content-type': 'text/plain', connection: 'close' });
      response.end(`Egress to ${target.hostname} refused: ${refusal.reason}\n`);
      return;
    }
    record('HTTP', target.hostname, port, 'ALLOW');
    const headers = {};
    for (const [name, value] of Object.entries(request.headers))
      if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
    headers['host'] = target.host;
    const upstream = http.request(
      {
        host: address,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
        timeout: IDLE_TIMEOUT_MS,
      },
      (reply) => {
        const replyHeaders = {};
        for (const [name, value] of Object.entries(reply.headers))
          if (!HOP_BY_HOP.has(name) && value !== undefined) replyHeaders[name] = value;
        response.writeHead(reply.statusCode ?? 502, replyHeaders);
        reply.pipe(response);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end();
    });
    request.pipe(upstream);
  });

  server.on('connect', async (request, client, head) => {
    client.on('error', () => client.destroy());
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(request.url ?? '');
    const host = match ? match[1] : String(request.url ?? '');
    const port = match ? Number(match[2]) : NaN;
    let address;
    try {
      if (!match) throw new Refusal(400, 'TARGET_INVALID');
      address = await resolve(host, port);
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal(502, 'PROXY_ERROR');
      record('CONNECT', host, port, 'DENY', refusal.reason);
      client.end(
        `HTTP/1.1 ${refusal.status} Egress refused\r\ncontent-type: text/plain\r\n` +
          `connection: close\r\n\r\nEgress to ${normalizeHost(host)} refused: ${refusal.reason}\n`,
      );
      return;
    }
    record('CONNECT', host, port, 'ALLOW');
    const upstream = connect({ host: address, port }, () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    upstream.on('error', () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
    });
    client.on('close', () => upstream.destroy());
  });

  // Upgrades (WebSocket over plain HTTP) are not forwarded.
  server.on('upgrade', (request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\n\r\n');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const allowedHosts = (process.env['EGRESS_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const port = Number(process.env['EGRESS_PROXY_PORT'] ?? 3128);
  const server = createEgressProxy({ allowedHosts });
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`${JSON.stringify({ event: 'ready', port, allowedHosts })}\n`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
