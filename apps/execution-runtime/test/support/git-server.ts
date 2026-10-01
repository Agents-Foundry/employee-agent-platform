import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';

export interface RecordedRequest {
  method: string;
  url: string;
  host: string;
  authorization: string | undefined;
}

export interface GitServer {
  port: number;
  /** CA bundle (the self-signed certificate) for `gitCaFile`. */
  caFile: string;
  requests: RecordedRequest[];
  /**
   * - `serve`: a real smart-HTTP git server (`git http-backend`);
   * - `redirect`: every request is redirected to `redirectTo`;
   * - `leak`: answers with a git error that quotes the request's credentials;
   * - `stall`: accepts requests and never answers.
   */
  mode: 'serve' | 'redirect' | 'leak' | 'stall';
  redirectTo: string;
  close(): Promise<void>;
}

/** Whether this machine can run the HTTPS git server (openssl and git http-backend). */
export function gitServerAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    const execPath = execFileSync('git', ['--exec-path'], { stdio: 'pipe' }).toString().trim();
    return ['git-http-backend', 'git-http-backend.exe'].some((name) =>
      existsSync(join(execPath, name)),
    );
  } catch {
    return false;
  }
}

/** A self-signed certificate valid for `hostnames`, generated with openssl. */
export function selfSignedCertificate(
  directory: string,
  hostnames: readonly string[],
): { key: string; cert: string; caFile: string } {
  mkdirSync(directory, { recursive: true });
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const config = join(directory, 'openssl.cnf');
  writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=ext',
      'prompt=no',
      '[dn]',
      `CN=${hostnames[0]}`,
      '[ext]',
      `subjectAltName=${hostnames.map((name) => `DNS:${name}`).join(',')}`,
      'basicConstraints=critical,CA:TRUE',
    ].join('\n'),
  );
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', config].concat([
      '-keyout',
      key,
      '-out',
      cert,
    ]),
    { stdio: 'pipe' },
  );
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8'), caFile: cert };
}

const pkt = (payload: string) =>
  (Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0') + payload;

/**
 * An HTTPS git host for tests. With `credentials`, every request must carry exactly that HTTP
 * Basic `user:password`; anything else gets 401. Every request is recorded, including its
 * `Authorization` header, so tests can prove where a credential was and was not sent.
 */
export async function startGitServer(options: {
  /** Directory of bare repositories, served as `/<path>`. */
  projectRoot: string;
  certificate: { key: string; cert: string; caFile: string };
  credentials?: string;
}): Promise<GitServer> {
  const sockets = new Set<Duplex>();
  const expected = options.credentials
    ? `Basic ${Buffer.from(options.credentials).toString('base64')}`
    : undefined;
  const state: Pick<GitServer, 'requests' | 'mode' | 'redirectTo'> = {
    requests: [],
    mode: 'serve',
    redirectTo: '',
  };
  const server = https.createServer(
    { key: options.certificate.key, cert: options.certificate.cert },
    (request, response) => {
      const authorization = request.headers.authorization;
      state.requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        host: request.headers.host ?? '',
        authorization,
      });
      if (state.mode === 'stall') return;
      if (state.mode === 'redirect') {
        response.writeHead(302, { location: `${state.redirectTo}${request.url}` }).end();
        return;
      }
      if (expected && authorization !== expected) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
        return;
      }
      if (state.mode === 'leak') {
        response.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'cache-control': 'no-cache',
        });
        const [, encoded = ''] = (authorization ?? '').split(' ');
        const plain = Buffer.from(encoded, 'base64').toString('utf8');
        response.end(
          pkt('# service=git-upload-pack\n') +
            '0000' +
            pkt(`ERR access denied for ${authorization} (${plain})`),
        );
        return;
      }
      const url = new URL(request.url ?? '/', 'https://git.invalid');
      const child = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env['PATH'] ?? '',
          ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
          GIT_PROJECT_ROOT: options.projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: request.method ?? 'GET',
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          ...(request.headers['content-length']
            ? { CONTENT_LENGTH: request.headers['content-length'] }
            : {}),
          ...(request.headers['content-encoding']
            ? { HTTP_CONTENT_ENCODING: String(request.headers['content-encoding']) }
            : {}),
          ...(request.headers['git-protocol']
            ? { GIT_PROTOCOL: String(request.headers['git-protocol']) }
            : {}),
          REMOTE_ADDR: '127.0.0.1',
          REMOTE_USER: 'test',
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      request.pipe(child.stdin);
      child.stdin.on('error', () => {});
      let head = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (headersSent) return void response.write(chunk);
        head = Buffer.concat([head, chunk]);
        let end = head.indexOf('\r\n\r\n');
        let gap = 4;
        if (end < 0) {
          end = head.indexOf('\n\n');
          gap = 2;
        }
        if (end < 0) return;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
          const at = line.indexOf(':');
          if (at < 0) continue;
          const name = line.slice(0, at).trim().toLowerCase();
          const value = line.slice(at + 1).trim();
          if (name === 'status') status = Number(value.split(' ')[0]);
          else headers[name] = value;
        }
        response.writeHead(status, headers);
        headersSent = true;
        response.write(head.subarray(end + gap));
      });
      child.on('close', () => {
        if (!headersSent) response.writeHead(500);
        response.end();
      });
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return Object.assign(state, {
    port: (server.address() as AddressInfo).port,
    caFile: options.certificate.caFile,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  });
}
