import { Router, type Express } from 'express';
import type { AuthConfig } from '../auth.js';
import type { ControlPlaneDatabase } from '../database.js';
import { activationUrl } from '../organization-routes.js';

export function configureTenancyRoutes(
  app: Express,
  db: ControlPlaneDatabase,
  config: AuthConfig,
): void {
  const router = Router(),
    service = db.tenancy;
  router.use((_req, res, next) => {
    if (config.mode !== 'password') {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    next();
  });
  router.get('/profile', async (_req, res) => res.json(await service.profile(res.locals['actor'])));
  router.get('/setup-progress', async (_req, res) =>
    res.json(await service.setupProgress(res.locals['actor'])),
  );
  router.put('/profile', async (req, res) =>
    res.json(await service.updateProfile(res.locals['actor'], req.body)),
  );
  router.get('/domains', async (_req, res) =>
    res.json(await service.listDomains(res.locals['actor'])),
  );
  router.post('/domains', async (req, res) =>
    res.status(201).json(await service.registerDomain(res.locals['actor'], req.body)),
  );
  router.post('/domains/:id/verify', async (req, res) =>
    res.json(await service.verifyDomain(res.locals['actor'], req.params['id'])),
  );
  router.post('/domains/:id/primary', async (req, res) =>
    res.json(await service.setPrimaryDomain(res.locals['actor'], req.params['id'])),
  );
  router.get('/employees', async (req, res) =>
    res.json(await service.listEmployees(res.locals['actor'], req.query)),
  );
  router.post('/employees', async (req, res) =>
    res.status(201).json(await service.createEmployee(res.locals['actor'], req.body)),
  );
  router.put('/employees/:id', async (req, res) =>
    res.json(await service.updateEmployee(res.locals['actor'], req.params['id'], req.body)),
  );
  router.put('/employees/:id/position', async (req, res) =>
    res.json(await service.assignPosition(res.locals['actor'], req.params['id'], req.body)),
  );
  router.post('/employees/:id/invitation', async (req, res) => {
    try {
      const result = await db.inviteExistingEmployee(res.locals['actor'], req.params['id']);
      if (config.mode !== 'password') return;
      res.status(201).json({
        employeeId: result.employeeId,
        expiresAt: result.expiresAt,
        activationUrl: activationUrl(config.employeeUrl, result.token, result.purpose),
        purpose: result.purpose,
        delivery: 'MANUAL',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ['ACCOUNT_NOT_ACTIVE', 'MEMBER_ALREADY_EXISTS'].includes(error.message)
      ) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  router.get('/memberships', async (req, res) =>
    res.json(await service.listMemberships(res.locals['actor'], req.query)),
  );
  router.put('/memberships/:id/status', async (req, res) =>
    res.json(await service.setMembershipStatus(res.locals['actor'], req.params['id'], req.body)),
  );
  app.use('/api/organization', router);
}
