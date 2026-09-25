import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { CatalogService } from './catalog-service.js';
import type { InstallationService } from './installation-service.js';

/**
 * Catalog reads are available to any authenticated actor (blueprints hold no tenant data).
 * Installations are tenant administration: password-mode organization admins only.
 */
export function configureCatalogRoutes(
  app: Express,
  catalog: CatalogService,
  installations: InstallationService,
  config: AuthConfig,
): void {
  const catalogRouter = Router();
  catalogRouter.get('/blueprints', (_req, res) => res.json(catalog.summaries()));
  catalogRouter.get('/blueprints/:id/versions/:version', (req, res) =>
    res.json(catalog.bundle(String(req.params['id']), String(req.params['version']), 404)),
  );
  app.use('/api/catalog/v1', catalogRouter);

  const router = Router();
  router.use((_req, res, next) => {
    if (config.mode !== 'password') {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    next();
  });
  router.get('/', (req, res) => res.json(installations.list(res.locals['actor'], req.query)));
  router.post('/', (req, res) =>
    res.status(201).json(installations.create(res.locals['actor'], req.body)),
  );
  router.put('/:id', (req, res) =>
    res.json(installations.update(res.locals['actor'], String(req.params['id']), req.body)),
  );
  router.post('/:id/retire', (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(installations.retire(res.locals['actor'], String(req.params['id']), version));
  });
  app.use('/api/organization/agent-installations', router);
}
