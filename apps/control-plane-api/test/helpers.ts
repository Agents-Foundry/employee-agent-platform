import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import type { ControlPlaneDatabase } from '../src/database.js';

export const demoRequest = (app: Express) =>
  request.agent(app).set({
    'x-actor-id': 'employee_qa_demo',
    'x-actor-role': 'EMPLOYEE',
    'x-organization-id': 'org_agents_foundry',
  });
export const createDemoApp = (database: ControlPlaneDatabase) =>
  createApp(database, { mode: 'demo' });
