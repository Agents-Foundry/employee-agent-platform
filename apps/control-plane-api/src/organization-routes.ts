import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import type { ControlPlaneDatabase } from './database.js';
import type { AuthConfig } from './auth.js';

export const memberInput = z
  .object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(200),
    team: z.string().trim().min(1).max(120),
  })
  .strict();
export function activationUrl(base: string, token: string): string {
  const url = new URL(base);
  // Fragments are not sent in HTTP requests, access logs, or Referer headers.
  url.hash = new URLSearchParams({ activate: token }).toString();
  return url.href;
}
export function configureOrganizationRoutes(
  app: Express,
  db: ControlPlaneDatabase,
  config: AuthConfig,
) {
  const admin: RequestHandler = (_req, res, next) => {
    if (config.mode !== 'password') {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (res.locals['actor'].role !== 'ADMIN') {
      res.status(403).json({ error: 'ADMIN_ROLE_REQUIRED' });
      return;
    }
    next();
  };
  app.get('/api/organization/members', admin, (_req, res) =>
    res.json(db.listMembers(res.locals['actor'].organizationId)),
  );
  app.post('/api/organization/invitations', admin, (req, res) => {
    if (config.mode !== 'password') return;
    const input = memberInput.parse(req.body);
    try {
      const invitation = db.inviteEmployee(res.locals['actor'], input);
      res
        .status(201)
        .json({
          employeeId: invitation.employeeId,
          expiresAt: invitation.expiresAt,
          activationUrl: activationUrl(config.employeeUrl, invitation.token),
          delivery: 'MANUAL',
        });
    } catch (error) {
      if (error instanceof Error && error.message === 'MEMBER_ALREADY_EXISTS') {
        res.status(409).json({ error: 'EMAIL_UNAVAILABLE' });
        return;
      }
      throw error;
    }
  });
  app.post('/api/organization/members/:id/disable', admin, (req, res) => {
    db.disableMember(res.locals['actor'], z.string().uuid().parse(req.params['id']));
    res.status(204).end();
  });
}
