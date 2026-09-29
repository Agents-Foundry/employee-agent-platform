import { Router, type Express } from 'express';
import type { AuthConfig } from '../auth.js';
import type { ModelSpendingService } from './model-spending-service.js';

/**
 * Model spending administration (ADR 0021): the organization's token limits and its usage.
 * Tenant administration, so password-mode organization admins only; the tenant always comes
 * from the session.
 */
export function configureSpendingRoutes(
  app: Express,
  spending: ModelSpendingService,
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
  router.get('/model-budget', async (_req, res) =>
    res.json(await spending.getBudget(res.locals['actor'])),
  );
  router.put('/model-budget', async (req, res) =>
    res.json(await spending.setBudget(res.locals['actor'], req.body)),
  );
  router.get('/model-usage', async (req, res) =>
    res.json(await spending.usage(res.locals['actor'], req.query)),
  );
  app.use('/api/organization', router);
}
