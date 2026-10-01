import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { CatalogService } from './catalog-service.js';
import type { InstallationService } from './installation-service.js';
import type { ModelQualityService } from '../quality/quality-service.js';

/**
 * Catalog reads are available to any authenticated actor (blueprints hold no tenant data).
 * Installations are tenant administration: password-mode organization admins only.
 */
export function configureCatalogRoutes(
  app: Express,
  catalog: CatalogService,
  installations: InstallationService,
  quality: ModelQualityService,
  config: AuthConfig,
): void {
  const catalogRouter = Router();
  catalogRouter.get('/blueprints', async (_req, res) => res.json(await catalog.summaries()));
  catalogRouter.get('/blueprints/:id/versions/:version', async (req, res) =>
    res.json(await catalog.bundle(String(req.params['id']), String(req.params['version']), 404)),
  );
  // Model-quality results describe catalog roles; admins read them to choose models (ADR 0026).
  catalogRouter.get('/quality', async (req, res) =>
    res.json(await quality.overview(res.locals['actor'], req.query)),
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
  router.get('/', async (req, res) =>
    res.json(await installations.list(res.locals['actor'], req.query)),
  );
  router.post('/', async (req, res) =>
    res.status(201).json(await installations.create(res.locals['actor'], req.body)),
  );
  router.put('/:id', async (req, res) =>
    res.json(await installations.update(res.locals['actor'], String(req.params['id']), req.body)),
  );
  router.post('/:id/retire', async (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(await installations.retire(res.locals['actor'], String(req.params['id']), version));
  });
  app.use('/api/organization/agent-installations', router);
}
