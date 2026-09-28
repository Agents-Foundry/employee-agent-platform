import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEgressProxy, hostAllowed, isBlockedAddress } from '../sandbox/egress-proxy.mjs';

describe('egress proxy', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  const servers: http.Server[] = [];
  const decisions: Record<string, unknown>[] = [];
  const names: Record<string, string[]> = {
    'allowed.test': ['127.0.0.1'],
    'metadata.test': ['169.254.169.254'],
    'mixed.test': ['10.0.0.8', '127.0.0.1'],
  };

  const listen = async (server: http.Server) => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  /** A proxy that may reach loopback, so the test upstream on 127.0.0.1 stands in for a host. */
  const proxy = (allowedHosts: string[], blocking = false) =>
    listen(
      createEgressProxy({
        allowedHosts,
        log: (entry) => decisions.push(entry),
        lookup: async (host) => {
          if (!names[host]) throw new Error('ENOTFOUND');
          return names[host];
        },
        ...(blocking ? {} : { isBlocked: () => false }),
      }),
    );
  const viaProxy = (proxyPort: number, url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, path: url }, (reply) => {
        let body = '';
        reply.on('data', (chunk) => (body += chunk));
        reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      request.end();
    });
  const tunnel = (proxyPort: number, target: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: target,
      });
      request.on('connect', (reply, socket) => {
        if (reply.statusCode !== 200) {
          socket.destroy();
          resolve({ status: reply.statusCode ?? 0, body: '' });
          return;
        }
        let body = '';
        socket.on('data', (chunk) => (body += chunk));
        socket.on('end', () => resolve({ status: 200, body }));
        socket.write(`GET /tunnel HTTP/1.1\r\nhost: ${target}\r\nconnection: close\r\n\r\n`);
      });
      request.on('error', reject);
      request.end();
    });

  beforeEach(async () => {
    decisions.length = 0;
    upstream = http.createServer((request, response) => {
      response.end(`upstream saw ${request.url} for ${request.headers.host}`);
    });
    upstreamPort = await listen(upstream);
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('matches exact hostnames only', () => {
    expect(hostAllowed('QA.Example.com.', ['qa.example.com'])).toBe(true);
    expect(hostAllowed('evil.qa.example.com', ['qa.example.com'])).toBe(false);
    expect(hostAllowed('qa.example.com.evil.test', ['qa.example.com'])).toBe(false);
    expect(hostAllowed('', [''])).toBe(false);
    expect(hostAllowed('[::1]', ['::1'])).toBe(true);
  });

  it('blocks loopback, link-local, unspecified and multicast addresses', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'not-an-address',
    ])
      expect(isBlockedAddress(address), address).toBe(true);
    for (const address of ['10.0.0.8', '192.168.65.254', '140.82.112.3', '2606:4700::1111'])
      expect(isBlockedAddress(address), address).toBe(false);
  });

  it('forwards plain HTTP and CONNECT tunnels to allowed hosts only', async () => {
    const port = await proxy(['allowed.test']);
    const plain = await viaProxy(port, `http://allowed.test:${upstreamPort}/page?q=1`);
    expect(plain).toEqual({
      status: 200,
      body: `upstream saw /page?q=1 for allowed.test:${upstreamPort}`,
    });
    const tunnelled = await tunnel(port, `allowed.test:${upstreamPort}`);
    expect(tunnelled.status).toBe(200);
    expect(tunnelled.body).toContain('upstream saw /tunnel');

    expect((await viaProxy(port, `http://other.test:${upstreamPort}/`)).status).toBe(403);
    expect((await tunnel(port, `other.test:${upstreamPort}`)).status).toBe(403);
    // An IP literal is a host like any other: not allowed unless the grant names it.
    expect((await tunnel(port, `127.0.0.1:${upstreamPort}`)).status).toBe(403);
    expect((await viaProxy(port, '/relative')).status).toBe(400);
    expect((await viaProxy(port, `https://allowed.test:${upstreamPort}/`)).status).toBe(400);
    expect((await tunnel(port, 'allowed.test:99999')).status).toBe(400);

    expect(decisions).toEqual([
      {
        event: 'egress',
        decision: 'ALLOW',
        method: 'HTTP',
        host: 'allowed.test',
        port: upstreamPort,
      },
      {
        event: 'egress',
        decision: 'ALLOW',
        method: 'CONNECT',
        host: 'allowed.test',
        port: upstreamPort,
      },
      expect.objectContaining({ decision: 'DENY', host: 'other.test', reason: 'HOST_NOT_ALLOWED' }),
      expect.objectContaining({ decision: 'DENY', method: 'CONNECT', reason: 'HOST_NOT_ALLOWED' }),
      expect.objectContaining({ decision: 'DENY', host: '127.0.0.1', reason: 'HOST_NOT_ALLOWED' }),
      expect.objectContaining({ decision: 'DENY', reason: 'SCHEME_NOT_SUPPORTED' }),
      expect.objectContaining({ decision: 'DENY', reason: 'PORT_INVALID' }),
    ]);
    // Paths and queries never reach the log.
    expect(JSON.stringify(decisions)).not.toContain('page');
  });

  it('refuses allowed names that resolve to blocked or unknown addresses', async () => {
    const port = await proxy(['metadata.test', 'mixed.test', 'missing.test'], true);
    expect((await tunnel(port, 'metadata.test:80')).status).toBe(403);
    expect((await viaProxy(port, 'http://mixed.test/')).status).toBe(403);
    expect((await tunnel(port, 'missing.test:443')).status).toBe(502);
    expect(decisions.map((entry) => entry['reason'])).toEqual([
      'ADDRESS_NOT_ALLOWED',
      'ADDRESS_NOT_ALLOWED',
      'RESOLUTION_FAILED',
    ]);
  });
});
