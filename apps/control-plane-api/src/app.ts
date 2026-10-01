import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import type { QaRunRequest, QaRunResponse } from '@agents-foundry/contracts';
import { evaluatePolicy } from '../../../packages/policy-engine/src/index.js';
import { ControlPlaneDatabase } from './database.js';
import { configureAuth, loadAuthConfig, type AuthConfig, type GoogleSignIn } from './auth.js';
import { configureOrganizationRoutes } from './organization-routes.js';
import { configureStructureRoutes } from './organization/structure-routes.js';
import { OrganizationDomainError } from './organization/structure-service.js';
import { configureJobRoutes } from './organization/job-routes.js';
import { configureTenancyRoutes } from './organization/tenancy-routes.js';
import { configureExecutionRoutes } from './execution/execution-routes.js';
import { configureCatalogRoutes } from './catalog/catalog-routes.js';
import { configureRuntimeRoutes } from './runtime/runtime-routes.js';
import { configureSpendingRoutes } from './spending/spending-routes.js';
import { configureWebhookRoutes } from './webhooks/webhook-routes.js';
import { configureActionRoutes } from './actions/action-routes.js';
import { ExecutionError } from './execution/execution-service.js';
import { RuntimeProtocolError } from '../../../packages/contracts/src/runtime/v1/schemas.js';

const provisioningSchema = z
  .object({
    // Existence, answers and capabilities are resolved against the catalog of record.
    blueprintId: z.string().min(1).max(120),
    blueprintVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    provider: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._-]+$/),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9._:/-]+$/),
    credentialMode: z.enum(['EMPLOYEE_BYOK', 'ORGANIZATION_MANAGED']),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  })
  .strict();

const createConversationSchema = z.object({
  employeeId: z.string().min(1).max(120),
  agentId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(140),
});

const addMessageSchema = z.object({
  author: z.enum(['EMPLOYEE', 'AGENT', 'SYSTEM']),
  content: z.string().trim().min(1).max(20_000),
});

const qaRunSchema = z.object({
  employeeId: z.string().min(1).max(120),
  conversationId: z.string().uuid(),
  storyKey: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]+-\d+$/),
  targetUrl: z.url().refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), {
    message: 'Only HTTP(S) targets are allowed.',
  }),
  instructions: z.string().trim().min(1).max(2000).optional(),
});

const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
});

export function createApp(
  database: ControlPlaneDatabase,
  auth: AuthConfig = loadAuthConfig(),
  google?: GoogleSignIn,
) {
  const app = express();
  const allowedOrigins =
    auth.mode !== 'demo'
      ? [new URL(auth.adminUrl).origin, new URL(auth.employeeUrl).origin]
      : (
          process.env['ALLOWED_ORIGINS'] ??
          'http://localhost:4200,http://localhost:4300,tauri://localhost'
        )
          .split(',')
          .map((origin) => origin.trim());

  const canonicalHosts = new Set(
    auth.mode === 'demo'
      ? ['localhost', '127.0.0.1']
      : [new URL(auth.adminUrl).hostname, new URL(auth.employeeUrl).hostname, '127.0.0.1'].filter(
          (host) => host !== '127.0.0.1' || process.env['NODE_ENV'] !== 'production',
        ),
  );

  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(async (request, response, next) => {
    const host = request.hostname.toLowerCase().replace(/\.$/, '');
    const tenantId = await database.tenancy.resolveVerifiedDomain(host);
    if (tenantId) response.locals['tenantOrganizationId'] = tenantId;
    else if (!canonicalHosts.has(host)) {
      response.status(421).json({ error: 'UNRECOGNIZED_HOST' });
      return;
    }
    next();
  });
  app.use(
    cors((request, callback) => {
      const origin = request.header('origin');
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, { credentials: true, origin: true });
      const verifiedTenantOrigin = async () => {
        try {
          const parsed = new URL(origin);
          return (
            parsed.protocol === 'https:' &&
            !parsed.port &&
            parsed.hostname === request.hostname.toLowerCase().replace(/\.$/, '') &&
            Boolean(await database.tenancy.resolveVerifiedDomain(parsed.hostname))
          );
        } catch {
          return false; // Invalid origins are rejected.
        }
      };
      verifiedTenantOrigin().then(
        (allowed) =>
          allowed
            ? callback(null, { credentials: true, origin: true })
            : callback(new Error('ORIGIN_FORBIDDEN')),
        (error: Error) => callback(error),
      );
    }),
  );
  // Signed runtime transport: its own body parser, limits and authentication (ADR 0011).
  configureRuntimeRoutes(app, database.runtimeIdentities, database.runtimeTransport);
  app.use(express.json({ limit: '64kb' }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );

  app.get('/api/health', async (_request, response) => {
    response.json({
      status: 'ok',
      service: 'control-plane-api',
      timestamp: new Date().toISOString(),
    });
  });

  const authenticate = configureAuth(app, database, auth, google);
  app.use('/api', authenticate, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/auth/session', async (_request, response) =>
    response.json(response.locals['actor']),
  );
  configureOrganizationRoutes(app, database, auth);
  configureStructureRoutes(app, database.structure, auth);
  configureJobRoutes(app, database.jobs, auth);
  configureTenancyRoutes(app, database, auth);
  configureExecutionRoutes(app, database.execution, {
    genericRuntimeEnabled: database.genericRuntimeEnabled,
    loadManifest: (agentId, organizationId, employeeId) =>
      database.getManifest(agentId, organizationId, employeeId),
    loadConversation: (conversationId, organizationId, employeeId) =>
      database.getConversation(conversationId, organizationId, employeeId),
  });
  configureCatalogRoutes(app, database.catalog, database.installations, database.quality, auth);
  configureActionRoutes(app, database.connectors, database.actionPolicies, auth);
  configureSpendingRoutes(app, database.modelSpending, auth);
  configureWebhookRoutes(app, database.alertWebhooks, auth);

  app.get('/api/bootstrap', async (_request, response) => {
    response.json(await database.getBootstrap(response.locals['actor'], auth.mode === 'demo'));
  });

  app.get('/api/blueprints', async (_request, response) =>
    response.json(await database.catalog.legacyBlueprints()),
  );
  app.get('/api/organization/agents', async (_request, response) => {
    const actor = response.locals['actor'];
    if (auth.mode !== 'password' || actor.role !== 'ADMIN')
      return response.status(403).json({ error: 'ADMIN_ROLE_REQUIRED' });
    return response.json(await database.listAgentAssignments(actor.organizationId));
  });
  app.post('/api/organization/agents', async (request, response) => {
    const actor = response.locals['actor'];
    if (auth.mode !== 'password' || actor.role !== 'ADMIN')
      return response.status(403).json({ error: 'ADMIN_ROLE_REQUIRED' });
    const input = provisioningSchema
      .extend({
        requestId: z.string().uuid(),
        installationId: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(120),
        employeeIds: z
          .array(z.string().uuid())
          .min(1)
          .max(25)
          .refine((ids) => new Set(ids).size === ids.length)
          .transform((ids) => ids.sort()),
      })
      .strict()
      .parse(request.body);
    try {
      return response.status(201).json(await database.createAssignedAgents(actor, input));
    } catch (error) {
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT')
        return response.status(409).json({ error: 'IDEMPOTENCY_CONFLICT' });
      throw error;
    }
  });
  app.get('/api/manifest-key', async (_request, response) =>
    response.json(database.signer.verificationKey),
  );
  app.get('/api/provisioning', async (_request, response) => {
    const actor = response.locals['actor'];
    response.json(
      await database.listProvisioning(
        actor.organizationId,
        actor.role === 'EMPLOYEE' ? actor.id : undefined,
      ),
    );
  });
  app.post('/api/provisioning', async (request, response) => {
    const actor = response.locals['actor'];
    if (actor.role !== 'EMPLOYEE')
      return response.status(403).json({ error: 'EMPLOYEE_ROLE_REQUIRED' });
    const input = provisioningSchema.parse(request.body);
    return response
      .status(201)
      .json(await database.requestProvisioning(actor.id, input, actor.organizationId));
  });
  app.post('/api/provisioning/:id/decision', async (request, response) => {
    const actor = response.locals['actor'];
    if (actor.role !== 'ADMIN') return response.status(403).json({ error: 'ADMIN_ROLE_REQUIRED' });
    const input = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED']),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(request.body);
    return response.json(
      await database.decideProvisioning(
        String(request.params['id']),
        actor.organizationId,
        actor.id,
        input.decision,
        input.reason,
      ),
    );
  });
  app.get('/api/agents/:id/manifest', async (request, response) => {
    const actor = response.locals['actor'];
    response.json(
      await database.getManifest(
        String(request.params['id']),
        actor.organizationId,
        actor.role === 'EMPLOYEE' ? actor.id : undefined,
      ),
    );
  });
  app.get('/api/lifecycle-events', async (_request, response) => {
    const actor = response.locals['actor'];
    if (actor.role !== 'ADMIN') return response.status(403).json({ error: 'ADMIN_ROLE_REQUIRED' });
    return response.json(await database.listLifecycleEvents(actor.organizationId));
  });

  app.get('/api/conversations', async (request, response) => {
    const actor = response.locals['actor'];
    if (request.query['employeeId'] && request.query['employeeId'] !== actor.id)
      return response.status(403).json({ error: 'ACTOR_FORBIDDEN' });
    return response.json(await database.listConversations(actor.id, actor.organizationId));
  });

  app.post('/api/conversations', async (request, response) => {
    const input = createConversationSchema.parse(request.body);
    const actor = response.locals['actor'];
    if (actor.role !== 'EMPLOYEE' || input.employeeId !== actor.id)
      return response.status(403).json({ error: 'ACTOR_FORBIDDEN' });
    return response
      .status(201)
      .json(
        await database.createConversation(
          actor.id,
          input.agentId,
          input.title,
          actor.organizationId,
          auth.mode === 'demo',
        ),
      );
  });

  app.get('/api/conversations/:id', async (request, response) => {
    const actor = response.locals['actor'];
    response.json(
      await database.getConversation(String(request.params['id']), actor.organizationId, actor.id),
    );
  });

  app.post('/api/conversations/:id/messages', async (request, response) => {
    const input = addMessageSchema.parse(request.body);
    const actor = response.locals['actor'];
    if (actor.role !== 'EMPLOYEE' || input.author !== 'EMPLOYEE')
      return response.status(403).json({ error: 'ACTOR_FORBIDDEN' });
    return response
      .status(201)
      .json(
        await database.addMessage(
          String(request.params['id']),
          'EMPLOYEE',
          input.content,
          actor.organizationId,
          actor.id,
        ),
      );
  });

  app.post('/api/qa/runs', async (request, response) => {
    const input: QaRunRequest = qaRunSchema.parse(request.body);
    const actor = response.locals['actor'];
    if (actor.role !== 'EMPLOYEE' || input.employeeId !== actor.id)
      return response.status(403).json({ error: 'ACTOR_FORBIDDEN' });
    await database.getConversation(input.conversationId, actor.organizationId, actor.id);
    if (database.qaGenericRuntimeEnabled) {
      const generic = await database.createGenericQaRun(
        input,
        actor.organizationId,
        auth.mode === 'demo',
      );
      if (generic) return response.status(202).json(generic);
    }
    const policy = evaluatePolicy('qa.execute_playwright');
    if (policy.outcome !== 'REQUIRE_APPROVAL') {
      return response.status(500).json({ error: 'POLICY_CONFIGURATION_ERROR' });
    }
    const plan = [
      `Read acceptance criteria from ${input.storyKey}`,
      'Map impacted UI and API paths from the assigned repositories',
      'Generate deterministic smoke and regression scenarios',
      `Run isolated Playwright checks against ${new URL(input.targetUrl).origin}`,
      'Capture trace, screenshots, console, and network evidence',
      'Draft defects for human review; never publish automatically',
    ];
    const { instructions: _unused, ...legacyInput } = input;
    const legacy = await database.createQaRun(
      {
        ...legacyInput,
        plan,
        approvalSummary: `Approve isolated Playwright execution for ${input.storyKey} against ${input.targetUrl}.`,
      },
      actor.organizationId,
      auth.mode === 'demo',
    );
    const result: QaRunResponse = { mode: 'LEGACY_STATIC_PLAN', ...legacy };
    await database.addMessage(
      input.conversationId,
      'AGENT',
      `I prepared a six-step QA plan for ${input.storyKey}. Browser execution is paused for admin approval (${result.approval.id}).`,
      actor.organizationId,
      actor.id,
    );
    return response.status(202).json(result);
  });

  app.get('/api/approvals', async (_request, response) => {
    const actor = response.locals['actor'];
    response.json(
      await database.listApprovals(
        actor.organizationId,
        actor.role === 'EMPLOYEE' ? actor.id : undefined,
      ),
    );
  });

  app.post('/api/approvals/:id/decision', async (request, response) => {
    const actor = response.locals['actor'];
    if (actor.role !== 'ADMIN') {
      return response.status(403).json({ error: 'ADMIN_ROLE_REQUIRED' });
    }
    const { decision } = approvalDecisionSchema.parse(request.body);
    return response.json(
      await database.decideApproval(
        String(request.params['id']),
        decision,
        actor.id,
        actor.organizationId,
      ),
    );
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'NOT_FOUND' });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof OrganizationDomainError || error instanceof ExecutionError)
      return response.status(error.status).json({ error: error.message });
    if (error instanceof RuntimeProtocolError)
      return response.status(400).json({ error: error.code, details: error.issues });
    if (error instanceof Error && error.message.endsWith('_FORBIDDEN')) {
      return response.status(403).json({ error: error.message });
    }
    if (error instanceof Error && error.message === 'MANIFEST_INVALID') {
      return response.status(409).json({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      return response.status(400).json({ error: 'VALIDATION_ERROR', details: error.issues });
    }
    if (error instanceof Error && error.message.endsWith('_NOT_FOUND')) {
      return response.status(404).json({ error: error.message });
    }
    if (
      error instanceof Error &&
      (error.message === 'APPROVAL_ALREADY_DECIDED' || error.message === 'APPROVAL_EXPIRED')
    ) {
      return response.status(409).json({ error: error.message });
    }
    console.error(error);
    return response.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  });

  return app;
}
