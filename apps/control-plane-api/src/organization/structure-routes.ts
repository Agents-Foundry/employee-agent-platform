import { Router, type Express } from 'express';
import { z } from 'zod';
import type { AuthConfig } from '../auth.js';
import type { OrganizationStructureService } from './structure-service.js';

export function configureStructureRoutes(
  app: Express,
  service: OrganizationStructureService,
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
  router.get('/', (req, res) => res.json(service.list(res.locals['actor'], req.query)));
  router.get('/employee-options', (req, res) =>
    res.json(service.employeeOptions(res.locals['actor'], req.query)),
  );
  router.post('/', (req, res) => res.status(201).json(service.save(res.locals['actor'], req.body)));
  router.get('/:id/ancestors', (req, res) =>
    res.json(service.ancestors(res.locals['actor'], req.params['id'])),
  );
  router.get('/:id/head-position-options', (req, res) =>
    res.json(service.headPositionOptions(res.locals['actor'], req.params['id'], req.query)),
  );
  router.put('/:id/head', (req, res) =>
    res.json(service.setHeadPosition(res.locals['actor'], req.params['id'], req.body)),
  );
  router.put('/:id', (req, res) =>
    res.json(service.save(res.locals['actor'], req.body, req.params['id'])),
  );
  router.post('/:id/archive', (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    service.archive(res.locals['actor'], req.params['id'], version);
    res.status(204).end();
  });
  router.get('/:id/members', (req, res) =>
    res.json(service.members(res.locals['actor'], req.params['id'], req.query)),
  );
  router.post('/:id/members', (req, res) => {
    service.addMember(res.locals['actor'], req.params['id'], req.body);
    res.status(201).json({ saved: true });
  });
  router.delete('/:id/members/:membershipId', (req, res) => {
    service.removeMember(res.locals['actor'], req.params['id'], req.params['membershipId']);
    res.status(204).end();
  });
  app.use('/api/organization/units', router);
}
