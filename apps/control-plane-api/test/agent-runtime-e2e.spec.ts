import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agents-foundry/contracts';
import { createDemoApp as createApp, demoRequest } from './helpers.js';
import { ControlPlaneDatabase } from '../src/database.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import { ModelGateway, type ModelResponse } from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry, type RuntimeTool } from '../../agent-runtime/src/tools/runtime-tool.js';
import { ArtifactTool } from '../../agent-runtime/src/tools/artifact-tool.js';
import { MemoryArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { MemoryCheckpointStore } from '../../agent-runtime/src/checkpoints.js';

const org = 'org_agents_foundry';
const employee = { id: 'employee_qa_demo', role: 'EMPLOYEE' as const, organizationId: org };
const adminHeaders = {
  'x-actor-id': 'admin_demo',
  'x-actor-role': 'ADMIN',
  'x-organization-id': org,
};
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Test double bound to the catalog's `browser@1.0.0` tool. Browser execution belongs to the
 * execution runtime (Phase E), so this only proves the runtime-executed approval path.
 */
class FakeBrowserTool implements RuntimeTool<{ title: string }> {
  readonly id = 'browser';
  readonly version = '1.0.0';
  readonly description = 'Run browser checks (test double).';
  readonly inputSchema = { type: 'object', properties: { title: { type: 'string' } } };
  executed: string[] = [];
  parse(input: unknown) {
    return z
      .object({ title: z.string().min(1) })
      .strict()
      .parse(input);
  }
  governedAction() {
    return 'qa.execute_playwright';
  }
  summarize(input: { title: string }) {
    return `Run browser check "${input.title}"`;
  }
  async execute(input: { title: string }) {
    this.executed.push(input.title);
    return { output: `Created test issue ${input.title}`, artifactIds: [] };
  }
}

/** Artifact first, then a governed issue, then a final answer. */
const script = (request: { messages: { content: { type: string }[] }[] }): ModelResponse => {
  const results = request.messages.flatMap((message) =>
    message.content.filter((block) => block.type === 'tool_result'),
  ).length;
  const usage = { inputTokens: 10, outputTokens: 5 };
  if (results === 0)
    return {
      content: [
        { type: 'text', text: 'Writing the test plan.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'artifact',
          input: { name: 'plan.md', type: 'report', mediaType: 'text/markdown', content: '# Plan' },
        },
      ],
      stopReason: 'tool_use',
      usage,
    };
  if (results === 1)
    return {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: 'browser',
          input: { title: 'Cart total wrong' },
        },
      ],
      stopReason: 'tool_use',
      usage,
    };
  return {
    content: [{ type: 'text', text: 'STORY-12 validated; one defect filed.' }],
    stopReason: 'end_turn',
    usage,
  };
};

describe('agent runtime end to end over the signed transport', () => {
  let db: ControlPlaneDatabase;
  let server: Server;
  let host: RuntimeHost;
  let issues: FakeBrowserTool;
  let artifacts: MemoryArtifactStore;
  let checkpoints: MemoryCheckpointStore;
  let agentId: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    db = new ControlPlaneDatabase(':memory:', true, {
      manifestV2Issuance: true,
      genericRuntime: true,
      runtimeIdentities: [
        {
          id: 'runtime-e2e',
          publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          organizations: [org],
          runtimeProfiles: ['standard-agent'],
        },
      ],
    });
    const pending = db.requestProvisioning(
      employee.id,
      {
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.1.0',
        provider: 'test-provider',
        model: 'test-model',
        credentialMode: 'ORGANIZATION_MANAGED',
        answers: {
          projectName: 'Checkout',
          repositoryUrl: 'https://example.com/repo',
          qaUrl: 'https://qa.example.com',
          issueTracker: ['Jira'],
          sourceControl: ['Bitbucket'],
          testingTechnologies: ['Playwright'],
        },
      },
      org,
    );
    agentId = manifestSubject(
      db.decideProvisioning(pending.id, org, 'admin_demo', 'APPROVED', 'Pilot').manifest!.payload,
    ).agentId;
    app = createApp(db);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    issues = new FakeBrowserTool();
    artifacts = new MemoryArtifactStore();
    checkpoints = new MemoryCheckpointStore();
    host = new RuntimeHost({
      controlPlane: new ControlPlaneClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        runtimeId: 'runtime-e2e',
        privateKey,
      }),
      verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
      kernel: new NativeKernel(),
      models: new ModelGateway([new ScriptedProvider('test-provider', script)], {
        resolve: async () => ({ apiKey: 'test-only' }),
      }),
      tools: new ToolRegistry([new ArtifactTool(), issues]),
      artifacts,
      checkpoints,
      logger: silent,
    });
  });

  afterEach(async () => {
    await host.drain();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('runs, pauses for approval, resumes after the admin decision and completes', async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({
          agentId,
          task: { objective: 'Validate STORY-12', workflow: 'validate-story', inputs: {} },
        })
        .expect(202)
    ).body;

    expect(await host.pollOnce()).toBe(true);
    await host.drain();
    let detail = db.execution.getRun(employee, run.id);
    expect(detail.run).toMatchObject({
      status: 'WAITING_FOR_APPROVAL',
      statusReason: 'APPROVAL_REQUIRED',
    });
    expect(issues.executed).toEqual([]);
    expect(checkpoints.items.has(run.id)).toBe(true);
    expect(detail.artifacts).toEqual([
      expect.objectContaining({ name: 'plan.md', type: 'report', sizeBytes: 6 }),
    ]);
    expect(artifacts.items.size).toBe(1);
    const approval = detail.approvals[0]!;
    expect(approval).toMatchObject({ action: 'qa.execute_playwright', status: 'PENDING' });

    // Nothing to do while the approval is pending.
    expect(await host.pollOnce()).toBe(false);
    await request(app)
      .post(`/api/approvals/${approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'APPROVED' })
      .expect(200);
    expect(await host.pollOnce()).toBe(true);
    await host.drain();

    detail = db.execution.getRun(employee, run.id);
    expect(detail.run).toMatchObject({ status: 'COMPLETED' });
    expect(issues.executed).toEqual(['Cart total wrong']);
    expect(checkpoints.items.size).toBe(0);
    expect(detail.steps.every((step) => step.status === 'COMPLETED')).toBe(true);
    expect(detail.steps.map((step) => step.kind)).toEqual([
      'MODEL',
      'TOOL',
      'MODEL',
      'TOOL',
      'MODEL',
    ]);

    const events = (
      await demoRequest(app).get(`/api/execution/v1/runs/${run.id}/events?limit=200`).expect(200)
    ).body.items as AgentEvent[];
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('artifact.created');
    expect(
      types.slice(types.indexOf('approval.requested'), types.indexOf('run.resumed') + 1),
    ).toEqual(['approval.requested', 'run.paused', 'approval.approved', 'run.resumed']);
    expect(types.at(-1)).toBe('run.completed');
    expect(events.at(-1)!.payload).toMatchObject({
      summary: 'STORY-12 validated; one defect filed.',
      artifactIds: [detail.artifacts[0]!.id],
    });
    // History carries digests and ids, never tool input, output or storage references.
    const history = JSON.stringify(events);
    expect(history).not.toContain('# Plan');
    expect(history).not.toContain('artifact://');
    expect(history).not.toContain('test-only');
  });

  it('stops without executing when the approval is rejected', async () => {
    const run = (
      await demoRequest(app)
        .post('/api/execution/v1/runs')
        .send({ agentId, task: { objective: 'Validate STORY-13', inputs: {} } })
        .expect(202)
    ).body;
    await host.pollOnce();
    await host.drain();
    const approval = db.execution.getRun(employee, run.id).approvals[0]!;
    await request(app)
      .post(`/api/approvals/${approval.id}/decision`)
      .set(adminHeaders)
      .send({ decision: 'REJECTED' })
      .expect(200);
    expect(await host.pollOnce()).toBe(true);
    await host.drain();
    expect(db.execution.getRun(employee, run.id).run).toMatchObject({
      status: 'CANCELLED',
      statusReason: 'APPROVAL_REJECTED',
    });
    expect(issues.executed).toEqual([]);
    expect(checkpoints.items.size).toBe(0);
  });
});
