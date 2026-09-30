import { Router, type Express } from 'express';
import type { AuthConfig } from '../auth.js';
import type { AlertWebhookService } from './alert-webhook-service.js';

/**
 * Alert webhook administration (ADR 0024). Tenant administration, so password-mode
 * organization admins only, and only when the operator enabled delivery; the tenant always
 * comes from the session.
 */
export function configureWebhookRoutes(
  app: Express,
  webhooks: AlertWebhookService,
  config: AuthConfig,
): void {
  const router = Router();
  router.use((_req, res, next) => {
    if (config.mode !== 'password' || !webhooks.options.enabled) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    next();
  });
  router.get('/', async (_req, res) => res.json(await webhooks.list(res.locals['actor'])));
  router.post('/', async (req, res) =>
    res.status(201).json(await webhooks.create(res.locals['actor'], req.body)),
  );
  router.put('/:webhookId', async (req, res) =>
    res.json(await webhooks.setStatus(res.locals['actor'], req.params['webhookId'], req.body)),
  );
  router.post('/:webhookId/test', async (req, res) =>
    res.status(202).json(await webhooks.test(res.locals['actor'], req.params['webhookId'])),
  );
  app.use('/api/organization/alert-webhooks', router);
}
