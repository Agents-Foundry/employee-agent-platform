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
  router.get('/profile', (_req, res) => res.json(service.profile(res.locals['actor'])));
  router.get('/setup-progress', (_req, res) =>
    res.json(service.setupProgress(res.locals['actor'])),
  );
  router.put('/profile', (req, res) =>
    res.json(service.updateProfile(res.locals['actor'], req.body)),
  );
  router.get('/domains', (_req, res) => res.json(service.listDomains(res.locals['actor'])));
  router.post('/domains', (req, res) =>
    res.status(201).json(service.registerDomain(res.locals['actor'], req.body)),
  );
  router.post('/domains/:id/verify', async (req, res) =>
    res.json(await service.verifyDomain(res.locals['actor'], req.params['id'])),
  );
  router.post('/domains/:id/primary', (req, res) =>
    res.json(service.setPrimaryDomain(res.locals['actor'], req.params['id'])),
  );
  router.get('/employees', (req, res) =>
    res.json(service.listEmployees(res.locals['actor'], req.query)),
  );
  router.post('/employees', (req, res) =>
    res.status(201).json(service.createEmployee(res.locals['actor'], req.body)),
  );
  router.put('/employees/:id', (req, res) =>
    res.json(service.updateEmployee(res.locals['actor'], req.params['id'], req.body)),
  );
  router.put('/employees/:id/position', (req, res) =>
    res.json(service.assignPosition(res.locals['actor'], req.params['id'], req.body)),
  );
  router.post('/employees/:id/invitation', (req, res) => {
    try {
      const result = db.inviteExistingEmployee(res.locals['actor'], req.params['id']);
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
  router.get('/memberships', (req, res) =>
    res.json(service.listMemberships(res.locals['actor'], req.query)),
  );
  router.put('/memberships/:id/status', (req, res) =>
    res.json(service.setMembershipStatus(res.locals['actor'], req.params['id'], req.body)),
  );
  app.use('/api/organization', router);
}
