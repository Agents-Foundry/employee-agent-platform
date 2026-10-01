import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { CredentialBroker } from './credential-broker.js';
import type { SourceControlConnectionService } from './source-control-connections.js';

/**
 * Repository credential administration (ADR 0031): source-control connections, and the
 * metadata of credential leases with revocation. Organization administrators only; no route
 * ever returns a secret.
 */
export function configureCredentialRoutes(
  app: Express,
  connections: SourceControlConnectionService,
  credentials: CredentialBroker,
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

  const sourceControl = passwordOnly();
  sourceControl.get('/', async (_req, res) =>
    res.json(await connections.list(res.locals['actor'])),
  );
  sourceControl.post('/', async (req, res) =>
    res.status(201).json(await connections.create(res.locals['actor'], req.body)),
  );
  sourceControl.post('/:id/disable', async (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    res.json(await connections.disable(res.locals['actor'], String(req.params['id']), version));
  });

  const leases = passwordOnly();
  leases.get('/', async (_req, res) => res.json(await credentials.list(res.locals['actor'])));
  leases.post('/:id/revoke', async (req, res) =>
    res.json(await credentials.revoke(res.locals['actor'], z.uuid().parse(req.params['id']))),
  );

  app.use('/api/organization/source-control-connections', sourceControl);
  app.use('/api/organization/credential-leases', leases);
}
