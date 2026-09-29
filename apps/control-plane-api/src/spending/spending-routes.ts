import { Router, type Express } from 'express';
import type { AuthConfig } from '../auth.js';
import type { ModelSpendingService } from './model-spending-service.js';

/**
 * Model spending administration (ADRs 0021 and 0022): the organization's limits, its model
 * prices and its usage.
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
  router.get('/model-prices', async (_req, res) =>
    res.json(await spending.prices.list(res.locals['actor'])),
  );
  router.put('/model-prices', async (req, res) =>
    res.json(await spending.prices.set(res.locals['actor'], req.body)),
  );
  router.post('/model-prices/remove', async (req, res) => {
    await spending.prices.remove(res.locals['actor'], req.body);
    res.status(204).end();
  });
  app.use('/api/organization', router);
}
