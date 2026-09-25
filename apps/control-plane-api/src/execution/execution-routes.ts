import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AgentRun, AnySignedAgentManifest } from '@agents-foundry/contracts';
import { taskSpecSchema } from '../../../../packages/contracts/src/runtime/v1/schemas.js';
import { ExecutionError, type ExecutionService } from './execution-service.js';

const eventQuery = z
  .object({
    afterSequence: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const startRunSchema = z
  .object({
    agentId: z.string().min(1).max(120),
    title: z.string().trim().min(1).max(200).optional(),
    threadId: z.uuid().optional(),
    task: taskSpecSchema,
  })
  .strict();

export interface ExecutionRouteOptions {
  /** `GENERIC_AGENT_RUNTIME_ENABLED`: starting generic runs is off unless explicitly enabled. */
  genericRuntimeEnabled: boolean;
  loadManifest: (
    agentId: string,
    organizationId: string,
    employeeId: string,
  ) => AnySignedAgentManifest;
}

/** Strip runtime bookkeeping from a run before it reaches a browser. */
function runView(run: AgentRun & { runtimeSequence?: number }): AgentRun {
  const { runtimeSequence: _hidden, ...view } = run;
  return view;
}

/**
 * Generic execution API (ADR 0003). The tenant and actor always come from the authenticated
 * session. Runtimes use the separate signed `/runtime/v1` transport (ADR 0011), never these routes.
 */
export function configureExecutionRoutes(
  app: Express,
  service: ExecutionService,
  options: ExecutionRouteOptions,
): void {
  const router = Router();
  const id = (value: unknown, missing: string) => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new ExecutionError(404, missing);
    return parsed.data;
  };
  router.get('/threads/:id', (req, res) => {
    res.json(service.getThread(res.locals['actor'], id(req.params['id'], 'THREAD_NOT_FOUND')));
  });
  router.get('/runs/:id', (req, res) => {
    res.json(service.getRun(res.locals['actor'], id(req.params['id'], 'RUN_NOT_FOUND')));
  });
  router.get('/runs/:id/events', (req, res) => {
    const query = eventQuery.parse(req.query);
    res.json(
      service.listEvents(
        res.locals['actor'],
        id(req.params['id'], 'RUN_NOT_FOUND'),
        query.afterSequence,
        query.limit,
      ),
    );
  });
  // An employee starts a run for an agent assigned to them; the runtime picks it up.
  router.post('/runs', (req, res) => {
    if (!options.genericRuntimeEnabled) throw new ExecutionError(404, 'GENERIC_RUNTIME_DISABLED');
    const actor = res.locals['actor'];
    const input = startRunSchema.parse(req.body);
    const manifest = options.loadManifest(input.agentId, actor.organizationId, actor.id);
    if (manifest.payload.apiVersion !== 'agents-foundry/v2')
      throw new ExecutionError(409, 'RUNTIME_MANIFEST_V2_REQUIRED');
    if (input.task.workflow && !manifest.payload.workflows.includes(input.task.workflow))
      throw new ExecutionError(400, 'WORKFLOW_NOT_IN_MANIFEST');
    const run = service.createRun({
      organizationId: actor.organizationId,
      employeeId: actor.id,
      agentId: input.agentId,
      title: input.title ?? input.task.objective,
      task: input.task,
      manifest,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    res.status(202).json(runView(run));
  });
  router.post('/runs/:id/cancel', (req, res) => {
    res.json(
      runView(service.cancelOwnRun(res.locals['actor'], id(req.params['id'], 'RUN_NOT_FOUND'))),
    );
  });
  app.use('/api/execution/v1', router);
}
