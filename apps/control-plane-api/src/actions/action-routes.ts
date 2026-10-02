import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { ActionPolicyService } from './action-policy-service.js';
import type { ConnectorService } from './connector-service.js';
import type { ActionReconciliationService } from './action-reconciliation.js';

const actionParam = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/);

/**
 * Action Gateway administration (ADR 0012): connector connections and tighten-only policy
 * overrides. Tenant administration, so password-mode organization admins only.
 */
export function configureActionRoutes(
  app: Express,
  connectors: ConnectorService,
  policies: ActionPolicyService,
  reconciliations: ActionReconciliationService,
  config: AuthConfig,
): void {
  const passwordOnly = () => {
    const router = Router();
    router.use((_req, res, next) => {
      if (config.mode !== 'password') {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      next();
    });
    return router;
  };

  const connections = passwordOnly();
  connections.get('/', async (_req, res) => res.json(await connectors.list(res.locals['actor'])));
  connections.post('/', async (req, res) =>
    res.status(201).json(await connectors.create(res.locals['actor'], req.body)),
  );
  connections.post('/:id/disable', async (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(await connectors.disable(res.locals['actor'], String(req.params['id']), version));
  });

  const actionPolicies = passwordOnly();
  actionPolicies.get('/', async (_req, res) => res.json(await policies.list(res.locals['actor'])));
  actionPolicies.put('/:action', async (req, res) =>
    res.json(
      await policies.set(res.locals['actor'], actionParam.parse(req.params['action']), req.body),
    ),
  );
  actionPolicies.delete('/:action', async (req, res) => {
    await policies.clear(res.locals['actor'], actionParam.parse(req.params['action']));
    res.status(204).end();
  });

  // ADR 0036: writes whose outcome is unknown, for an administrator to check and resolve.
  const reconciliation = passwordOnly();
  reconciliation.get('/', async (_req, res) =>
    res.json(await reconciliations.list(res.locals['actor'])),
  );
  reconciliation.post('/:requestId/resolution', async (req, res) =>
    res.json(
      await reconciliations.resolve(
        res.locals['actor'],
        z.uuid().parse(req.params['requestId']),
        req.body,
      ),
    ),
  );

  app.use('/api/organization/action-reconciliations', reconciliation);
  app.use('/api/organization/connector-connections', connections);
  app.use('/api/organization/action-policies', actionPolicies);
}
