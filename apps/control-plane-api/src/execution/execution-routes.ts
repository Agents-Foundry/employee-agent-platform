import { Router, type Express } from 'express';
import { z } from 'zod';
import { ExecutionError, type ExecutionService } from './execution-service.js';

const eventQuery = z
  .object({
    afterSequence: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/**
 * Read-only generic execution API (ADR 0003). The tenant and actor always come from the
 * authenticated session. No runtime-ingestion route exists until runtimes have a workload
 * identity (ADR 0002); runs are created only by governed control-plane workflows.
 */
export function configureExecutionRoutes(app: Express, service: ExecutionService): void {
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
  app.use('/api/execution/v1', router);
}
