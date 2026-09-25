import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { ActionPolicyService } from './action-policy-service.js';
import type { ConnectorService } from './connector-service.js';

const actionParam = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/);

/**
 * Action Gateway administration (ADR 0012): connector connections and tighten-only policy
 * overrides. Tenant administration, so password-mode organization admins only.
 */
export function configureActionRoutes(
  app: Express,
  connectors: ConnectorService,
  policies: ActionPolicyService,
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
  connections.get('/', (_req, res) => res.json(connectors.list(res.locals['actor'])));
  connections.post('/', (req, res) =>
    res.status(201).json(connectors.create(res.locals['actor'], req.body)),
  );
  connections.post('/:id/disable', (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(connectors.disable(res.locals['actor'], String(req.params['id']), version));
  });

  const actionPolicies = passwordOnly();
  actionPolicies.get('/', (_req, res) => res.json(policies.list(res.locals['actor'])));
  actionPolicies.put('/:action', (req, res) =>
    res.json(policies.set(res.locals['actor'], actionParam.parse(req.params['action']), req.body)),
  );
  actionPolicies.delete('/:action', (req, res) => {
    policies.clear(res.locals['actor'], actionParam.parse(req.params['action']));
    res.status(204).end();
  });

  app.use('/api/organization/connector-connections', connections);
  app.use('/api/organization/action-policies', actionPolicies);
}
