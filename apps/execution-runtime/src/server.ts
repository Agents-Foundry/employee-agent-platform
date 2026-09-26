import { createServer, type IncomingMessage, type Server } from 'node:http';
import { executionPaths } from '../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { ExecutionRefused, type ExecutionService } from './execution-service.js';
import type { ExecutionProvider } from './providers/execution-provider.js';

const MAX_BODY_BYTES = 256 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) throw new ExecutionRefused(413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ExecutionRefused(400, 'REQUEST_INVALID');
  }
}

/**
 * Minimal HTTP surface. Authority comes only from the signed grant in each request; the server
 * binds to loopback by default so only co-located agent runtimes can reach it.
 */
export function createExecutionServer(
  service: ExecutionService,
  provider: ExecutionProvider,
): Server {
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET' && request.url === executionPaths.health)
        return send(200, {
          status: 'ok',
          provider: provider.id,
          isolation: provider.isolation,
          enforces: provider.enforces,
        });
      if (request.method !== 'POST' || request.url !== executionPaths.execute)
        return send(404, { error: 'NOT_FOUND' });
      if (!String(request.headers['content-type'] ?? '').startsWith('application/json'))
        return send(415, { error: 'JSON_REQUIRED' });
      const controller = new AbortController();
      response.on('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      return send(200, await service.execute(await readJson(request), controller.signal));
    } catch (error) {
      if (error instanceof ExecutionRefused) return send(error.status, { error: error.code });
      console.error(JSON.stringify({ level: 'error', message: 'execution failed' }));
      return send(500, { error: 'EXECUTION_RUNTIME_ERROR' });
    }
  });
}
