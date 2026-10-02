import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { ModelCredentialService } from './model-credentials.js';

/**
 * Model credential administration (ADR 0034): which secret reference holds the organization's
 * key for each model provider. Organization administrators only; no route returns a key.
 */
export function configureModelCredentialRoutes(
  app: Express,
  service: ModelCredentialService,
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
  router.get('/', async (_req, res) => res.json(await service.list(res.locals['actor'])));
  router.put('/:provider', async (req, res) =>
    res.json(await service.set(res.locals['actor'], String(req.params['provider']), req.body)),
  );
  router.post('/:provider/disable', async (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(await service.disable(res.locals['actor'], String(req.params['provider']), version));
  });
  app.use('/api/organization/model-credentials', router);
}
