import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { JobArchitectureService } from './job-service.js';
export function configureJobRoutes(
  app: Express,
  service: JobArchitectureService,
  config: AuthConfig,
): void {
  const router = Router();
  router.use((_req, res, next) => {
    if (config.mode !== 'password') {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    next();
  });
  router.get('/:kind', async (req, res) =>
    res.json(await service.list(res.locals['actor'], req.params['kind'], req.query)),
  );
  router.post('/:kind', async (req, res) =>
    res.status(201).json(await service.save(res.locals['actor'], req.params['kind'], req.body)),
  );
  router.put('/:kind/:id', async (req, res) =>
    res.json(
      await service.save(res.locals['actor'], req.params['kind'], req.body, req.params['id']),
    ),
  );
  router.post('/:kind/:id/archive', async (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    await service.archive(res.locals['actor'], req.params['kind'], req.params['id'], version);
    res.status(204).end();
  });
  app.use('/api/organization/jobs', router);
}
