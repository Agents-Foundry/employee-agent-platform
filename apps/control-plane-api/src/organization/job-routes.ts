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
  router.get('/:kind', (req, res) =>
    res.json(service.list(res.locals['actor'], req.params['kind'], req.query)),
  );
  router.post('/:kind', (req, res) =>
    res.status(201).json(service.save(res.locals['actor'], req.params['kind'], req.body)),
  );
  router.put('/:kind/:id', (req, res) =>
    res.json(service.save(res.locals['actor'], req.params['kind'], req.body, req.params['id'])),
  );
  router.post('/:kind/:id/archive', (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    service.archive(res.locals['actor'], req.params['kind'], req.params['id'], version);
    res.status(204).end();
  });
  app.use('/api/organization/jobs', router);
}
