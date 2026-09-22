import { demoRequest as request, createDemoApp as createApp } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';

describe('control plane API', () => {
  let database: ControlPlaneDatabase;

  beforeEach(() => {
    database = new ControlPlaneDatabase(':memory:');
  });

  afterEach(() => {
    database.close();
  });

  it('exposes the locked QA POC bootstrap model', async () => {
    const response = await request(createApp(database)).get('/api/bootstrap').expect(200);
    expect(response.body.organization.name).toBe('Agents Foundry');
    expect(response.body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'QA Engineer Agent', department: 'Engineering' }),
      ]),
    );
    expect(response.body.keyPolicy.allowedSources).toEqual([
      'EMPLOYEE_BYOK',
      'ORGANIZATION_MANAGED',
    ]);
  });

  it('centrally persists a conversation and its messages', async () => {
    const app = createApp(database);
    const created = await request(app)
      .post('/api/conversations')
      .send({
        employeeId: 'employee_qa_demo',
        agentId: 'agent_qa_engineer',
        title: 'Validate STORY-142',
      })
      .expect(201);
    await request(app)
      .post(`/api/conversations/${created.body.id}/messages`)
      .send({ author: 'EMPLOYEE', content: 'Create a regression plan.' })
      .expect(201);
    const detail = await request(app).get(`/api/conversations/${created.body.id}`).expect(200);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].content).toBe('Create a regression plan.');
  });

  it('creates a QA run behind a human approval gate', async () => {
    const app = createApp(database);
    const conversation = await request(app)
      .post('/api/conversations')
      .send({ employeeId: 'employee_qa_demo', agentId: 'agent_qa_engineer', title: 'STORY-142' })
      .expect(201);
    const response = await request(app)
      .post('/api/qa/runs')
      .send({
        employeeId: 'employee_qa_demo',
        conversationId: conversation.body.id,
        storyKey: 'STORY-142',
        targetUrl: 'https://staging.example.com',
      })
      .expect(202);
    expect(response.body.run.status).toBe('AWAITING_APPROVAL');
    expect(response.body.approval.status).toBe('PENDING');
    expect(response.body.approval.action).toBe('qa.execute_playwright');
  });

  it('rejects approval decisions from non-admin actors', async () => {
    const app = createApp(database);
    await request(app)
      .post('/api/approvals/not-real/decision')
      .set('x-actor-role', 'EMPLOYEE')
      .set('x-actor-id', 'employee_qa_demo')
      .send({ decision: 'APPROVED' })
      .expect(403);
  });
});
