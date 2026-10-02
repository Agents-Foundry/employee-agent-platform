import express, { Router, type Express, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { runtimeTransportPaths } from '../../../../packages/contracts/src/runtime/v1/transport.js';
import {
  MAX_CHECKPOINT_BYTES,
  MAX_RUNTIME_MESSAGE_BYTES,
} from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import { ExecutionError } from '../execution/execution-service.js';
import {
  authenticateRuntimeRequest,
  type RuntimeIdentity,
  type RuntimeIdentityRegistry,
} from './runtime-identity.js';
import type { RuntimeTransportService } from './runtime-transport-service.js';
import { credentialTransportPaths } from '../../../../packages/contracts/src/credentials.js';
import type { CredentialBroker } from '../credentials/credential-broker.js';
import { MAX_ARTIFACT_UPLOAD_BYTES } from '../../../../packages/contracts/src/artifacts.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';
import { MAX_DIRECT_ARTIFACT_BYTES } from '../../../../packages/contracts/src/artifacts.js';

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
  credentials: CredentialBroker,
  artifacts: ArtifactService,
): void {
  const router = Router();
  router.use(
    rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  // A checkpoint is a JSON string inside JSON, so its escaped form can be far larger.
  router.use(
    relative(runtimeTransportPaths.checkpointSave),
    express.raw({ type: () => true, limit: 3 * MAX_CHECKPOINT_BYTES }),
  );
  // Artifact bytes travel as base64 inside JSON, next to a signed grant or a correlation.
  router.use(
    relative(runtimeTransportPaths.artifactUpload),
    express.raw({
      type: () => true,
      limit: Math.ceil(MAX_ARTIFACT_UPLOAD_BYTES / 3) * 4 + MAX_RUNTIME_MESSAGE_BYTES,
    }),
  );
  // Direct uploads the store cannot take itself arrive here as raw bytes (ADR 0037).
  router.use(
    relative(runtimeTransportPaths.artifactContent),
    express.raw({ type: () => true, limit: MAX_DIRECT_ARTIFACT_BYTES }),
  );
  // Raw bytes are needed to verify the body digest in the signature.
  router.use(express.raw({ type: () => true, limit: MAX_RUNTIME_MESSAGE_BYTES + 1024 }));
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });

  const authenticateAny = (request: Request): Promise<RuntimeIdentity> =>
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
  const forRole =
    (role: RuntimeIdentity['role']) =>
    async (request: Request): Promise<RuntimeIdentity> => {
      const runtime = await authenticateAny(request);
      if (runtime.role !== role) throw new ExecutionError(403, 'RUNTIME_ROLE_FORBIDDEN');
      return runtime;
    };
  const authenticate = forRole('agent');
  const authenticateExecution = forRole('execution');
  const json = (request: Request): unknown => {
    if (!request.is('application/json')) throw new ExecutionError(415, 'RUNTIME_JSON_REQUIRED');
    try {
      return JSON.parse((request.body as Buffer).toString('utf8'));
    } catch {
      throw new ExecutionError(400, 'RUNTIME_MESSAGE_INVALID');
    }
  };

  router.post(relative(runtimeTransportPaths.claim), async (request, response) => {
    const runtime = await authenticate(request);
    // Runtimes poll here, so no scheduler is needed to expire credential leases (ADR 0031).
    await credentials.expireDue();
    const claim = await transport.claim(runtime);
    if (!claim) return response.status(204).end();
    return response.json(claim);
  });
  router.post(relative(runtimeTransportPaths.events), async (request, response) => {
    const runtime = await authenticate(request);
    const ack = await transport.ingest(runtime, json(request));
    response.status(ack.duplicate ? 200 : 201).json(ack);
  });
  router.post(relative(runtimeTransportPaths.actions), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.requestAction(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.execute), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.executeAction(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.grant), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.issueGrant(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.modelReserve), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.reserveModelTokens(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.modelCredential), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.modelCredential(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.modelSettle), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.settleModelTokens(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.heartbeat), async (request, response) => {
    const runtime = await authenticate(request);
    response.json(await transport.heartbeat(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.checkpointSave), async (request, response) => {
    const runtime = await authenticate(request);
    response.status(201).json(await transport.saveCheckpoint(runtime, json(request)));
  });
  router.post(relative(runtimeTransportPaths.checkpointLoad), async (request, response) => {
    const runtime = await authenticate(request);
    const checkpoint = await transport.loadCheckpoint(runtime, json(request));
    if (!checkpoint) return response.status(204).end();
    return response.json(checkpoint);
  });
  router.post(relative(runtimeTransportPaths.artifactUpload), async (request, response) => {
    const runtime = await authenticate(request);
    response.status(201).json(await artifacts.uploadFromAgent(runtime, json(request)));
  });
  router.post(
    relative(runtimeTransportPaths.artifactUploadExecution),
    async (request, response) => {
      const runtime = await authenticateExecution(request);
      response.status(201).json(await artifacts.uploadFromExecution(runtime, json(request)));
    },
  );
  router.post(
    relative(runtimeTransportPaths.artifactUploadAuthorize),
    async (request, response) => {
      const runtime = await authenticateExecution(request);
      response.status(201).json(await artifacts.authorizeDirectUpload(runtime, json(request)));
    },
  );
  router.put(
    `${relative(runtimeTransportPaths.artifactContent)}/:token`,
    async (request, response) => {
      const runtime = await authenticateExecution(request);
      await artifacts.receiveDirectContent(
        runtime,
        String(request.params['token']),
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
      );
      response.status(204).end();
    },
  );
  router.post(relative(runtimeTransportPaths.artifactUploadComplete), async (request, response) => {
    const runtime = await authenticateExecution(request);
    response.status(201).json(await artifacts.completeDirectUpload(runtime, json(request)));
  });
  router.post(relative(credentialTransportPaths.redeem), async (request, response) => {
    const runtime = await authenticateExecution(request);
    response.json(await credentials.redeem(runtime, json(request)));
  });
  router.post(relative(credentialTransportPaths.release), async (request, response) => {
    const runtime = await authenticateExecution(request);
    response.json(await credentials.release(runtime, json(request)));
  });
  app.use(RUNTIME_BASE, router);
}
