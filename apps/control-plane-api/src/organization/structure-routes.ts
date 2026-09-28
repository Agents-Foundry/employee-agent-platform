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
  router.get('/', async (req, res) => res.json(await service.list(res.locals['actor'], req.query)));
  router.get('/employee-options', async (req, res) =>
    res.json(await service.employeeOptions(res.locals['actor'], req.query)),
  );
  router.post('/', async (req, res) =>
    res.status(201).json(await service.save(res.locals['actor'], req.body)),
  );
  router.get('/:id/ancestors', async (req, res) =>
    res.json(await service.ancestors(res.locals['actor'], req.params['id'])),
  );
  router.get('/:id/head-position-options', async (req, res) =>
    res.json(await service.headPositionOptions(res.locals['actor'], req.params['id'], req.query)),
  );
  router.put('/:id/head', async (req, res) =>
    res.json(await service.setHeadPosition(res.locals['actor'], req.params['id'], req.body)),
  );
  router.put('/:id', async (req, res) =>
    res.json(await service.save(res.locals['actor'], req.body, req.params['id'])),
  );
  router.post('/:id/archive', async (req, res) => {
    const { version } = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    await service.archive(res.locals['actor'], req.params['id'], version);
    res.status(204).end();
  });
  router.get('/:id/members', async (req, res) =>
    res.json(await service.members(res.locals['actor'], req.params['id'], req.query)),
  );
  router.post('/:id/members', async (req, res) => {
    await service.addMember(res.locals['actor'], req.params['id'], req.body);
    res.status(201).json({ saved: true });
  });
  router.delete('/:id/members/:membershipId', async (req, res) => {
    await service.removeMember(res.locals['actor'], req.params['id'], req.params['membershipId']);
    res.status(204).end();
  });
  app.use('/api/organization/units', router);
}
