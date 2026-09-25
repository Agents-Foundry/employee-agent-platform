import express, { Router, type Express, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { runtimeTransportPaths } from '../../../../packages/contracts/src/runtime/v1/transport.js';
import { MAX_RUNTIME_MESSAGE_BYTES } from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import { ExecutionError } from '../execution/execution-service.js';
import {
  authenticateRuntimeRequest,
  type RuntimeIdentity,
  type RuntimeIdentityRegistry,
} from './runtime-identity.js';
import type { RuntimeTransportService } from './runtime-transport-service.js';

const RUNTIME_BASE = '/runtime/v1';
const relative = (path: string) => path.slice(RUNTIME_BASE.length);

/**
 * Runtime-only endpoints (ADR 0011). They sit outside `/api`, so browser sessions, cookies
 * and demo headers never reach them; every request must carry a valid workload signature.
 */
export function configureRuntimeRoutes(
  app: Express,
  registry: RuntimeIdentityRegistry,
  transport: RuntimeTransportService,
): void {
  const router = Router();
  router.use(
    rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  // Raw bytes are needed to verify the body digest in the signature.
  router.use(express.raw({ type: () => true, limit: MAX_RUNTIME_MESSAGE_BYTES + 1024 }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  const authenticate = (request: Request): RuntimeIdentity =>
    authenticateRuntimeRequest(
      registry,
      {
        method: request.method,
        path: request.originalUrl,
        header: (name) => request.header(name),
        body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      },
      (runtimeId, nonce, expiresAt) => transport.consumeNonce(runtimeId, nonce, expiresAt),
    );
  const json = (request: Request): unknown => {
    if (!request.is('application/json')) throw new ExecutionError(415, 'RUNTIME_JSON_REQUIRED');
    try {
      return JSON.parse((request.body as Buffer).toString('utf8'));
    } catch {
      throw new ExecutionError(400, 'RUNTIME_MESSAGE_INVALID');
    }
  };

  router.post(relative(runtimeTransportPaths.claim), (request, response) => {
    const runtime = authenticate(request);
    const claim = transport.claim(runtime);
    if (!claim) return response.status(204).end();
    return response.json(claim);
  });
  router.post(relative(runtimeTransportPaths.events), (request, response) => {
    const runtime = authenticate(request);
    const ack = transport.ingest(runtime, json(request));
    response.status(ack.duplicate ? 200 : 201).json(ack);
  });
  router.post(relative(runtimeTransportPaths.actions), (request, response) => {
    const runtime = authenticate(request);
    response.json(transport.requestAction(runtime, json(request)));
  });
  app.use(RUNTIME_BASE, router);
}
