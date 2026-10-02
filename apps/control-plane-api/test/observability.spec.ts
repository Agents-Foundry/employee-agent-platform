import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, ExecutionOperation } from '@agents-foundry/contracts';
import { ControlPlaneDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';
import { hashToken, type PasswordConfig } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { LOCAL_ISSUER } from '../src/onboarding-types.js';
import { MemorySecretStore } from '../src/actions/secrets.js';
import { configureMetricsRoute } from '../src/metrics-route.js';
import {
  ATTRIBUTE_KEYS,
  JsonLineSpanExporter,
  MAX_SERIES,
  METRICS,
  MemorySpanExporter,
  MetricRegistry,
  OtlpExporter,
  Telemetry,
  sanitizeAttributes,
  spanIdFor,
  telemetryFromEnvironment,
  traceIdForRun,
  type SpanRecord,
} from '../../../packages/telemetry/src/index.js';
import { runtimeKeyPair } from './runtime-helpers.js';
import { RuntimeHost } from '../../agent-runtime/src/runtime-host.js';
import { ControlPlaneClient } from '../../agent-runtime/src/transport/control-plane-client.js';
import { ExecutionClient } from '../../agent-runtime/src/transport/execution-client.js';
import { ManifestVerifier } from '../../agent-runtime/src/manifest-verifier.js';
import { NativeKernel } from '../../agent-runtime/src/kernel/native-kernel.js';
import { ModelGateway, type ModelResponse } from '../../agent-runtime/src/models/model-gateway.js';
import { ScriptedProvider } from '../../agent-runtime/src/models/scripted-provider.js';
import { ToolRegistry } from '../../agent-runtime/src/tools/runtime-tool.js';
import { ArtifactTool } from '../../agent-runtime/src/tools/artifact-tool.js';
import { IssueTrackerTool } from '../../agent-runtime/src/tools/issue-tracker-tool.js';
import { RepositoryTool } from '../../agent-runtime/src/tools/execution-tools.js';
import { ControlPlaneArtifactStore } from '../../agent-runtime/src/tools/artifact-store.js';
import { ControlPlaneCheckpointStore } from '../../agent-runtime/src/checkpoints.js';
import { ExecutionService } from '../../execution-runtime/src/execution-service.js';
import { GrantVerifier } from '../../execution-runtime/src/grant-verifier.js';
import { ExecutionArtifactStore } from '../../execution-runtime/src/artifact-store.js';
import { StateStore } from '../../execution-runtime/src/state-store.js';
import { createExecutionServer } from '../../execution-runtime/src/server.js';
import type {
  ExecutionProvider,
  ProviderOutcome,
} from '../../execution-runtime/src/providers/execution-provider.js';
import { testDatabase } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const config: PasswordConfig = {
  mode: 'password',
  adminUrl: 'http://localhost:4200/',
  employeeUrl: 'http://localhost:4300/',
  secureCookies: false,
};
const OBJECTIVE = 'File the checkout defect for the discount regression';
const REPORT_TEXT = 'Confidential plan: check the cart total against the price list.';
const MODEL_ANSWER = 'Filed the defect and stored the plan.';
const JIRA_TOKEN = 'jira-api-token-value-observability';
const MODEL_KEY = 'sk-observability-model-key-000111';
const draft = {
  projectKey: 'QA',
  summary: 'Cart total ignores the discount',
  description: 'Steps: add a discounted item.',
  issueType: 'Bug',
};
const checkout: ExecutionOperation = {
  kind: 'git.checkout',
  repositoryUrl: 'https://example.com/repo.git',
  ref: 'main',
  path: 'repo',
};
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const key = runtimeKeyPair();

const script = (input: { messages: { content: { type: string }[] }[] }): ModelResponse => {
  const results = input.messages.flatMap((message) =>
    message.content.filter((block) => block.type === 'tool_result'),
  ).length;
  const usage = { inputTokens: 11, outputTokens: 7 };
  const calls = [
    {
      name: 'artifact',
      input: { name: 'plan.md', type: 'report', mediaType: 'text/markdown', content: REPORT_TEXT },
    },
    { name: 'repository', input: checkout },
    { name: 'issue-tracker', input: draft },
  ];
  const next = calls[results];
  return next
    ? {
        content: [{ type: 'tool_use', id: `toolu_${results}`, name: next.name, input: next.input }],
        stopReason: 'tool_use',
        usage,
      }
    : { content: [{ type: 'text', text: MODEL_ANSWER }], stopReason: 'end_turn', usage };
};

class RecordingProvider implements ExecutionProvider {
  readonly id = 'recording';
  readonly isolation = 'local' as const;
  readonly enforces = ['timeout'] as const;
  async execute(): Promise<ProviderOutcome> {
    return {
      status: 'SUCCEEDED',
      output: 'Checked out.',
      truncated: false,
      artifacts: [],
      measurements: { sandboxStartupMs: 12, egressDenied: 2 },
    };
  }
}

describe('observability (ADR 0035)', () => {
  let hash: string;
  beforeAll(async () => {
    hash = await hashPassword('a long test-only password');
  });

  describe('a run across the control plane, the agent runtime and the execution runtime', () => {
    let db: ControlPlaneDatabase;
    let app: ReturnType<typeof createApp>;
    let server: Server;
    let executionServer: Server;
    let state: StateStore;
    let root: string;
    let host: RuntimeHost;
    let admin: Actor;
    let employee: Actor;
    let agentId: string;
    let spans: MemorySpanExporter;
    let telemetry: Telemetry;
    const sessions = new Map<string, string>();

    beforeEach(async () => {
      const secrets = new MemorySecretStore();
      spans = new MemorySpanExporter();
      // One exporter stands in for the collector all three processes send to.
      telemetry = new Telemetry('platform', [spans]);
      db = await testDatabase({
        seedDemo: false,
        manifestV2Issuance: true,
        genericRuntime: true,
        secrets,
        telemetry,
        connectorFetch: async () => Response.json({ id: '10001', key: 'QA-42' }, { status: 201 }),
        runtimeIdentities: [
          {
            id: 'runtime-a',
            publicKeySpki: key.spki,
            organizations: ['*'],
            runtimeProfiles: ['standard-agent'],
          },
        ],
      });
      app = createApp(db, config);
      const org = await db.createCustomer(
        { name: 'Alpha', slug: 'alpha' },
        { displayName: 'Admin', email: 'admin@alpha.example', team: 'Admin' },
      );
      await db.acceptInvitation(hashToken(org.token), hash);
      admin = { id: org.employeeId, organizationId: org.organizationId, role: 'ADMIN' };
      const invitation = await db.inviteEmployee(admin, {
        displayName: 'Quinn',
        email: 'quinn@alpha.example',
        team: 'QA',
      });
      await db.acceptInvitation(hashToken(invitation.token), hash);
      employee = {
        id: invitation.employeeId,
        organizationId: admin.organizationId,
        role: 'EMPLOYEE',
      };
      secrets.set(admin.organizationId, 'jira-token', JIRA_TOKEN);
      secrets.set(admin.organizationId, 'model-key', MODEL_KEY);
      for (const actor of [admin, employee]) {
        const token = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
        await db.createSession(hashToken(token), LOCAL_ISSUER, actor.id, Date.now() + 3600000);
        sessions.set(actor.id, `af_session=${token}`);
      }
      await call('post', '/api/organization/connector-connections', admin, {
        provider: 'jira',
        name: 'Alpha Jira',
        baseUrl: 'https://alpha.atlassian.net',
        secretRef: 'secret://jira-token',
        settings: { authEmail: 'bot@alpha.example', allowedProjects: ['QA'] },
      }).expect(201);
      const [assignment] = (
        await call('post', '/api/organization/agents', admin, {
          requestId: randomUUID(),
          name: 'Checkout QA agent',
          employeeIds: [employee.id],
          blueprintId: 'engineering.qa-engineer',
          blueprintVersion: '1.2.0',
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
        }).expect(201)
      ).body;
      agentId = assignment.agentId;
      server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      root = mkdtempSync(join(tmpdir(), 'af-observability-'));
      state = new StateStore(':memory:');
      const provider = new RecordingProvider();
      executionServer = createExecutionServer(
        new ExecutionService({
          verifier: new GrantVerifier(db.signer.verificationKey.publicKeySpki),
          provider,
          state,
          artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
          workspaceRoot: root,
          allowUnsandboxed: true,
          telemetry,
        }),
        provider,
      );
      await new Promise<void>((resolve) => executionServer.listen(0, '127.0.0.1', resolve));
      const controlPlane = new ControlPlaneClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        runtimeId: 'runtime-a',
        privateKey: key.privateKey,
      });
      const execution = new ExecutionClient(
        `http://127.0.0.1:${(executionServer.address() as AddressInfo).port}`,
      );
      host = new RuntimeHost({
        controlPlane,
        verifier: new ManifestVerifier(db.signer.verificationKey.publicKeySpki),
        kernel: new NativeKernel(),
        models: new ModelGateway([new ScriptedProvider('test-provider', script)], {
          resolve: async () => ({ apiKey: MODEL_KEY }),
        }),
        modelCredentials: () => ({ resolve: async () => ({ apiKey: MODEL_KEY }) }),
        tools: new ToolRegistry([
          new ArtifactTool(),
          new RepositoryTool(execution),
          new IssueTrackerTool(),
        ]),
        artifacts: new ControlPlaneArtifactStore(controlPlane),
        checkpoints: new ControlPlaneCheckpointStore(controlPlane),
        logger: silent,
        telemetry,
      });
    });

    afterEach(async () => {
      await host.drain();
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => executionServer.close(resolve)),
      ]);
      state.close();
      await db.close();
      rmSync(root, { recursive: true, force: true });
    });

    const call = (method: 'get' | 'post', path: string, actor: Actor, body?: object) => {
      const pending = request(app)
        [method](path)
        .set('Cookie', sessions.get(actor.id)!)
        .set('Origin', 'http://localhost:4200');
      return body ? pending.send(body) : pending;
    };

    it('is one connected trace per run, named by the platform’s own identifiers, with no content in it', async () => {
      const run = (
        await call('post', '/api/execution/v1/runs', employee, {
          agentId,
          task: { objective: OBJECTIVE, inputs: {} },
        }).expect(202)
      ).body as { id: string; threadId: string };
      await host.pollOnce();
      await host.drain();
      const approval = (await db.execution.getRun(employee, run.id)).approvals[0]!;
      await call('post', `/api/approvals/${approval.id}/decision`, admin, {
        decision: 'APPROVED',
      }).expect(200);
      await host.pollOnce();
      await host.drain();
      const detail = await db.execution.getRun(employee, run.id);
      expect(detail.run.status).toBe('COMPLETED');
      const artifact = detail.artifacts[0]!;
      const permission = (
        await call(
          'post',
          `/api/execution/v1/artifacts/${artifact.id}/retrievals`,
          employee,
        ).expect(201)
      ).body as { path: string };
      await call('get', permission.path, employee).expect(200);

      const all = spans.spans;
      // One trace, derived from the run: no process had to pass tracing headers to another.
      expect(new Set(all.map((span) => span.traceId))).toEqual(new Set([traceIdForRun(run.id)]));
      const byId = new Map(all.map((span) => [span.spanId, span]));
      expect(byId.size).toBe(all.length);
      const roots = all.filter((span) => !span.parentSpanId);
      expect(roots.map((span) => [span.name, span.spanId])).toEqual([
        ['agent.run', spanIdFor('run', run.id)],
      ]);
      // Every other span hangs under a span that exists.
      for (const span of all)
        if (span.parentSpanId) expect(byId.has(span.parentSpanId), span.name).toBe(true);
      const parentOf = (span: SpanRecord) => byId.get(span.parentSpanId!)!;
      const named = (name: string) => all.filter((span) => span.name === name);
      const only = (name: string) => {
        expect(named(name), name).toHaveLength(1);
        return named(name)[0]!;
      };

      // Thread → run → steps → model calls → reservations.
      expect(roots[0]!.attributes).toMatchObject({
        'af.thread.id': run.threadId,
        'af.run.id': run.id,
        'af.organization.id': admin.organizationId,
        'af.status': 'COMPLETED',
      });
      expect(named('run.step')).toHaveLength(detail.steps.length);
      expect(named('model.call')).toHaveLength(4);
      for (const model of named('model.call')) {
        expect(parentOf(model)).toMatchObject({
          name: 'run.step',
          attributes: { 'af.step.kind': 'MODEL' },
        });
        expect(model.attributes).toMatchObject({
          'af.model.provider': 'test-provider',
          'af.model.name': 'test-model',
          'af.model.input_tokens': 11,
          'af.model.output_tokens': 7,
        });
      }
      expect(named('model.budget.reserve')).toHaveLength(4);
      for (const reservation of named('model.budget.reserve'))
        expect(parentOf(reservation).name).toBe('model.call');

      // Tool calls → Action Gateway decisions → approval, grant, execution, connector.
      expect(named('tool.call').map((span) => span.attributes['af.tool.id'])).toEqual([
        'artifact',
        'repository',
        'issue-tracker',
      ]);
      for (const tool of named('tool.call'))
        expect(parentOf(tool)).toMatchObject({
          name: 'run.step',
          attributes: { 'af.step.kind': 'TOOL' },
        });
      const decisions = named('action.decision');
      expect(
        decisions.map((span) => [span.attributes['af.action'], span.attributes['af.decision']]),
      ).toEqual([
        ['repository.read', 'ALLOWED'],
        ['jira.issue.create', 'APPROVAL_REQUIRED'],
      ]);
      for (const decision of decisions) expect(parentOf(decision).name).toBe('tool.call');
      const grant = only('execution.grant');
      expect(parentOf(grant)).toBe(decisions[0]);
      const operation = only('execution.operation');
      expect(parentOf(operation)).toBe(grant);
      expect(operation.attributes).toMatchObject({
        'af.operation.kind': 'git.checkout',
        'af.grant.id': grant.attributes['af.grant.id'],
        'af.egress.denied': 2,
      });
      const wait = only('approval.wait');
      expect(wait.attributes).toMatchObject({
        'af.approval.id': approval.id,
        'af.action': 'jira.issue.create',
        'af.decision': 'APPROVED',
      });
      expect(parentOf(wait).name).toBe('run.step');
      const dispatch = only('connector.dispatch');
      expect(parentOf(dispatch)).toBe(decisions[1]);
      expect(dispatch.attributes).toMatchObject({ 'af.connector.provider': 'jira' });

      // Artifact creation and retrieval, and the checkpoints in between.
      const upload = only('artifact.upload');
      expect(parentOf(upload)).toBe(named('tool.call')[0]);
      expect(upload.attributes).toMatchObject({
        'af.artifact.id': artifact.id,
        'af.artifact.media_type': 'text/markdown',
        'af.artifact.retention': 'STANDARD_30D',
      });
      expect(parentOf(only('artifact.retrieve'))).toBe(upload);
      expect(named('checkpoint.save').length).toBeGreaterThan(5);

      // Identifiers and measurements only: the attribute names are a closed list, and no task
      // text, document, model output, connector payload, secret or person is in any of it.
      const allowed = new Set<string>(ATTRIBUTE_KEYS);
      for (const span of all)
        for (const name of Object.keys(span.attributes)) expect(allowed.has(name), name).toBe(true);
      const exported = JSON.stringify(all) + (await telemetry.metrics.prometheus());
      for (const forbidden of [
        OBJECTIVE,
        'discount',
        REPORT_TEXT,
        'Confidential',
        MODEL_ANSWER,
        draft.summary,
        JIRA_TOKEN,
        MODEL_KEY,
        employee.id,
        admin.id,
        'quinn@alpha.example',
        'alpha.atlassian.net',
        'example.com/repo',
      ])
        expect(exported, forbidden).not.toContain(forbidden);

      // The metrics an operator needs for the same run.
      const text = await telemetry.metrics.prometheus();
      for (const line of [
        'af_runs{status="QUEUED"} 0',
        'af_runs{status="RUNNING"} 0',
        'af_runs{status="WAITING_FOR_APPROVAL"} 0',
        'af_runs_created_total 1',
        'af_runs_finished_total{status="COMPLETED",reason="none"} 1',
        'af_run_duration_ms_count{status="COMPLETED"} 1',
        'af_run_queue_wait_ms_count 1',
        'af_runtime_leases{state="active"} 0',
        'af_checkpoint_writes_total{result="saved"}',
        'af_checkpoint_reads_total{result="loaded"} 1',
        'af_model_calls_total{provider="test-provider",model="test-model",result="succeeded"} 4',
        'af_model_latency_ms_count{provider="test-provider",model="test-model"} 4',
        'af_model_tokens_total{provider="test-provider",model="test-model",direction="input"} 44',
        'af_model_tokens_total{provider="test-provider",model="test-model",direction="output"} 28',
        'af_model_budget_decisions_total{decision="allowed",code="none"} 4',
        'af_tool_calls_total{tool="artifact",result="succeeded"} 1',
        'af_tool_calls_total{tool="repository",result="succeeded"} 1',
        'af_tool_calls_total{tool="issue-tracker",result="succeeded"} 1',
        'af_tool_duration_ms_count{tool="issue-tracker",result="succeeded"} 1',
        'af_action_decisions_total{action="repository.read",decision="allowed"} 1',
        'af_action_decisions_total{action="jira.issue.create",decision="approval_required"} 1',
        'af_action_executions_total{action="jira.issue.create",status="succeeded",code="none"} 1',
        'af_approvals_total{action="jira.issue.create",status="approved"} 1',
        'af_approval_wait_ms_count{action="jira.issue.create",status="approved"} 1',
        'af_execution_grants_total{operation="git.checkout",result="issued"} 1',
        'af_execution_operations_total{kind="git.checkout",status="SUCCEEDED",code="none"} 1',
        'af_execution_duration_ms_count{kind="git.checkout",status="SUCCEEDED"} 1',
        'af_execution_in_flight 0',
        'af_sandbox_startup_ms_count{provider="recording"} 1',
        'af_egress_denials_total{provider="recording"} 2',
        'af_secret_resolutions_total{provider="development",result="resolved"} 1',
        'af_secret_resolution_ms_count{provider="development"} 1',
        'af_connector_duration_ms_count{provider="jira",action="jira.issue.create",outcome="succeeded"} 1',
        'af_artifact_uploads_total{source="agent",result="stored"} 1',
        `af_artifact_upload_bytes_total{source="agent"} ${Buffer.byteLength(REPORT_TEXT)}`,
        'af_artifact_retrievals_total{result="retrieved"} 1',
        'af_runtime_active_runs 0',
      ])
        expect(text, line).toContain(line);
      expect(text).not.toContain('af_telemetry_dropped_total');
      // Nothing of the telemetry is in the database either: it is not another audit trail.
      expect(
        JSON.stringify(await rawSql(db).prepare('SELECT metadata FROM audit_events').all()),
      ).not.toContain(traceIdForRun(run.id));
    }, 90_000);

    it('counts refusals, conflicts and corrupt checkpoints', async () => {
      const run = (
        await call('post', '/api/execution/v1/runs', employee, {
          agentId,
          task: { objective: OBJECTIVE, inputs: {} },
        }).expect(202)
      ).body as { id: string };
      await host.pollOnce();
      await host.drain();
      const approval = (await db.execution.getRun(employee, run.id)).approvals[0]!;
      await call('post', `/api/approvals/${approval.id}/decision`, admin, {
        decision: 'REJECTED',
      }).expect(200);
      const text = await telemetry.metrics.prometheus();
      expect(text).toContain('af_approvals_total{action="jira.issue.create",status="rejected"} 1');
      expect(text).toContain(
        'af_runs_finished_total{status="CANCELLED",reason="APPROVAL_REJECTED"} 1',
      );
      const root = spans.spans.find((span) => span.name === 'agent.run')!;
      expect(root).toMatchObject({
        status: 'ERROR',
        attributes: { 'af.status': 'CANCELLED', 'af.reason': 'APPROVAL_REJECTED' },
      });
    }, 90_000);
  });

  describe('the telemetry layer', () => {
    it('keeps only listed attributes with identifier-like values', () => {
      let dropped = 0;
      const kept = sanitizeAttributes(
        {
          'af.run.id': '3d7e0e60-0000-4000-8000-000000000001',
          'af.model.name': 'claude-opus-5-5',
          'af.artifact.media_type': 'application/vnd.test+json',
          'af.model.input_tokens': 120,
          'af.status': 'COMPLETED',
          // Content, in every shape it could arrive.
          'af.reason': 'The user asked to file a defect',
          'af.action': 'x'.repeat(200),
          'af.tool.id': 'tool\nid',
          'af.decision': '"quoted"',
          'af.model.output_tokens': Number.NaN,
          'af.step.kind': { nested: true } as never,
          ['prompt' as never]: 'File the defect',
          ['http.url' as never]: 'https://example.com/?token=abc',
        },
        () => (dropped += 1),
      );
      expect(kept).toEqual({
        'af.run.id': '3d7e0e60-0000-4000-8000-000000000001',
        'af.model.name': 'claude-opus-5-5',
        'af.artifact.media_type': 'application/vnd.test+json',
        'af.model.input_tokens': 120,
        'af.status': 'COMPLETED',
      });
      expect(dropped).toBe(8);
      expect(sanitizeAttributes(undefined)).toEqual({});
    });

    it('derives stable trace and span identifiers from the platform’s own', () => {
      const runId = randomUUID();
      expect(traceIdForRun(runId)).toMatch(/^[0-9a-f]{32}$/);
      expect(traceIdForRun(runId)).toBe(traceIdForRun(runId));
      expect(traceIdForRun(runId)).not.toBe(traceIdForRun(randomUUID()));
      expect(spanIdFor('tool', runId)).toMatch(/^[0-9a-f]{16}$/);
      // The same identifier names different spans for different subjects.
      expect(spanIdFor('grant', runId)).not.toBe(spanIdFor('operation', runId));
      const exporter = new MemorySpanExporter();
      const telemetry = new Telemetry('test', [exporter]);
      telemetry.span({
        runId,
        name: 'Not A Valid Name',
        subject: 'tool',
        id: 'call-1',
        startTimeMs: 2000,
        endTimeMs: 1000,
        attributes: { 'af.tool.id': 'artifact', 'af.reason': 'free text here' },
      });
      expect(exporter.spans).toEqual([
        {
          traceId: traceIdForRun(runId),
          spanId: spanIdFor('tool', 'call-1'),
          parentSpanId: spanIdFor('run', runId),
          name: 'span',
          startTimeMs: 1000,
          endTimeMs: 1000,
          status: 'OK',
          attributes: { 'af.run.id': runId, 'af.tool.id': 'artifact' },
        },
      ]);
    });

    it('never lets an exporter or a collector fail the work being measured', async () => {
      const telemetry = new Telemetry('test', [
        {
          export: () => {
            throw new Error('exporter down');
          },
        },
      ]);
      telemetry.gauge('af_runs', async () => {
        throw new Error('database down');
      });
      telemetry.span({ runId: 'r', name: 'x', subject: 'run', id: 'r', startTimeMs: 1 });
      await expect(
        telemetry.trace({ runId: 'r', name: 'work', subject: 'tool', id: 't' }, async () => 7),
      ).resolves.toBe(7);
      const failure = Object.assign(new Error('boom'), { code: 'TOOL_FAILED' });
      await expect(
        telemetry.trace({ runId: 'r', name: 'work', subject: 'tool', id: 't' }, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      const text = await telemetry.metrics.prometheus();
      expect(text).toContain('af_telemetry_dropped_total{kind="span"} 3');
      expect(text).toContain('af_telemetry_dropped_total{kind="gauge_collection"} 1');
      await telemetry.flush();
    });

    it('bounds metric labels and series, and renders counters, gauges and histograms', async () => {
      const metrics = new MetricRegistry();
      metrics.count('af_tool_calls_total', { tool: 'artifact', result: 'succeeded' });
      metrics.count('af_tool_calls_total', { tool: 'artifact', result: 'succeeded' }, 2);
      // Not an identifier: never becomes a label value. Unknown labels are ignored.
      metrics.count('af_tool_calls_total', {
        tool: 'a tool with a prompt in it',
        result: 'x'.repeat(100),
        runId: 'never-a-label',
      });
      metrics.count('af_tool_calls_total', { tool: 'artifact' });
      metrics.count('af_tool_calls_total', { tool: 'artifact', result: 'ok' }, -5);
      metrics.observe('af_tool_duration_ms', 7, { tool: 'artifact', result: 'succeeded' });
      metrics.observe('af_tool_duration_ms', 700, { tool: 'artifact', result: 'succeeded' });
      metrics.observe('af_tool_duration_ms', 7_000_000, { tool: 'artifact', result: 'succeeded' });
      metrics.gauge('af_execution_in_flight', async () => [{ value: 3 }]);
      const text = await metrics.prometheus();
      expect(text).toContain('# TYPE af_tool_calls_total counter');
      expect(text).toContain('af_tool_calls_total{tool="artifact",result="succeeded"} 3');
      expect(text).toContain('af_tool_calls_total{tool="other",result="other"} 1');
      expect(text).toContain('af_tool_calls_total{tool="artifact",result="none"} 1');
      expect(text).not.toContain('never-a-label');
      expect(text).toContain('# TYPE af_tool_duration_ms histogram');
      expect(text).toContain(
        'af_tool_duration_ms_bucket{tool="artifact",result="succeeded",le="10"} 1',
      );
      expect(text).toContain(
        'af_tool_duration_ms_bucket{tool="artifact",result="succeeded",le="1000"} 2',
      );
      expect(text).toContain(
        'af_tool_duration_ms_bucket{tool="artifact",result="succeeded",le="+Inf"} 3',
      );
      expect(text).toContain('af_tool_duration_ms_sum{tool="artifact",result="succeeded"} 7000707');
      expect(text).toContain('af_execution_in_flight 3');
      // A label that takes too many values stops creating series; the overflow is counted.
      for (let index = 0; index < MAX_SERIES + 25; index += 1)
        metrics.count('af_runs_abandoned_total', { code: `CODE_${index}` });
      const families = await metrics.collect();
      expect(
        families.find((family) => family.name === 'af_runs_abandoned_total')!.points,
      ).toHaveLength(MAX_SERIES);
      expect(
        families.find((family) => family.name === 'af_telemetry_dropped_total')!.points[0],
      ).toMatchObject({ labels: { kind: 'metric_series' }, value: 25 });
      // No metric is labelled by a run, thread, person or organization.
      for (const definition of Object.values(METRICS))
        for (const label of definition.labels)
          expect(label).not.toMatch(/run|thread|employee|actor|organization|tenant|user/i);
    });

    it('exports spans and metrics as OTLP over HTTPS, and drops them when the collector is down', async () => {
      const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
      let up = true;
      const dropped: string[] = [];
      const exporter = new OtlpExporter({
        endpoint: 'https://collector.example.com/otlp/',
        service: 'control-plane',
        headers: () => ({ authorization: 'Bearer collector-token' }),
        maxQueue: 3,
        onDropped: (kind, count) => dropped.push(`${kind}:${count}`),
        fetch: (async (url: URL, init?: RequestInit) => {
          posts.push({
            url: String(url),
            headers: init!.headers as Record<string, string>,
            body: JSON.parse(String(init!.body)),
          });
          return new Response(null, { status: up ? 200 : 503 });
        }) as typeof fetch,
      });
      const telemetry = new Telemetry('control-plane', [exporter]);
      const runId = randomUUID();
      telemetry.span({
        runId,
        name: 'tool.call',
        subject: 'tool',
        id: 'call-1',
        startTimeMs: 1_700_000_000_000,
        endTimeMs: 1_700_000_000_250,
        status: 'ERROR',
        attributes: { 'af.tool.id': 'artifact', 'af.attempts': 2, 'error.code': 'TOOL_FAILED' },
      });
      await telemetry.flush();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        url: 'https://collector.example.com/otlp/v1/traces',
        headers: { authorization: 'Bearer collector-token', 'content-type': 'application/json' },
      });
      const sent = posts[0]!.body.resourceSpans[0];
      expect(sent.resource.attributes).toEqual([
        { key: 'service.name', value: { stringValue: 'control-plane' } },
      ]);
      expect(sent.scopeSpans[0].spans[0]).toEqual({
        traceId: traceIdForRun(runId),
        spanId: spanIdFor('tool', 'call-1'),
        parentSpanId: spanIdFor('run', runId),
        name: 'tool.call',
        kind: 1,
        startTimeUnixNano: '1700000000000000000',
        endTimeUnixNano: '1700000000250000000',
        attributes: [
          { key: 'af.run.id', value: { stringValue: runId } },
          { key: 'af.tool.id', value: { stringValue: 'artifact' } },
          { key: 'af.attempts', value: { intValue: '2' } },
          { key: 'error.code', value: { stringValue: 'TOOL_FAILED' } },
        ],
        status: { code: 2 },
      });

      telemetry.count('af_runs_created_total');
      telemetry.observe('af_run_duration_ms', 42, { status: 'COMPLETED' });
      telemetry.gauge('af_execution_in_flight', async () => [{ value: 1 }]);
      await exporter.sendMetrics(await telemetry.metrics.collect(), telemetry.metrics.startedAtMs);
      const metrics = posts[1]!.body.resourceMetrics[0].scopeMetrics[0].metrics;
      expect(posts[1]!.url).toBe('https://collector.example.com/otlp/v1/metrics');
      expect(metrics.map((metric: { name: string }) => metric.name)).toEqual([
        'af_runs_created_total',
        'af_run_duration_ms',
        'af_execution_in_flight',
      ]);
      expect(metrics[0].sum).toMatchObject({ isMonotonic: true, aggregationTemporality: 2 });
      expect(metrics[1].histogram.dataPoints[0]).toMatchObject({ count: '1', sum: 42 });
      const buckets = metrics[1].histogram.dataPoints[0].bucketCounts.map(Number);
      expect(buckets.reduce((total: number, value: number) => total + value, 0)).toBe(1);
      expect(buckets.length).toBe(metrics[1].histogram.dataPoints[0].explicitBounds.length + 1);

      // A collector that is down costs telemetry, never the request path.
      up = false;
      for (let index = 0; index < 5; index += 1)
        telemetry.span({ runId, name: 'x', subject: 'tool', id: `c${index}`, startTimeMs: 1 });
      await telemetry.flush();
      expect(dropped).toEqual(['span_queue:1', 'span_queue:1', 'span_export:3']);

      expect(
        () => new OtlpExporter({ endpoint: 'http://collector.example.com', service: 's' }),
      ).toThrow('TELEMETRY_ENDPOINT_HTTPS_REQUIRED');
      expect(
        () =>
          new OtlpExporter({ endpoint: 'https://user:pass@collector.example.com', service: 's' }),
      ).toThrow('TELEMETRY_ENDPOINT_INVALID');
    });

    it('is configured from the environment and refuses unknown exporters', () => {
      expect(telemetryFromEnvironment('s', {}).telemetry.service).toBe('s');
      expect(() => telemetryFromEnvironment('s', { TELEMETRY_EXPORTER: 'datadog' })).toThrow(
        'TELEMETRY_EXPORTER_INVALID',
      );
      expect(() => telemetryFromEnvironment('s', { TELEMETRY_EXPORTER: 'otlp' })).toThrow(
        'OTEL_EXPORTER_OTLP_ENDPOINT_REQUIRED',
      );
      const configured = telemetryFromEnvironment('s', {
        TELEMETRY_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      });
      void configured.start(60_000)();
      const lines: string[] = [];
      const console = new Telemetry('s', [
        new JsonLineSpanExporter('s', (line) => lines.push(line)),
      ]);
      console.span({ runId: 'r', name: 'agent.run', subject: 'run', id: 'r', startTimeMs: 1 });
      expect(JSON.parse(lines[0]!)).toMatchObject({
        telemetry: 'span',
        service: 's',
        name: 'agent.run',
      });
    });

    it('serves metrics only to a caller with the operator token', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'af-metrics-'));
      try {
        const token = 't'.repeat(40);
        const tokenPath = join(directory, 'token');
        writeFileSync(tokenPath, `${token}\n`);
        const telemetry = new Telemetry('control-plane');
        telemetry.count('af_runs_created_total');
        const app = express();
        configureMetricsRoute(app, telemetry, tokenPath);
        await request(app).get('/metrics').expect(401, { error: 'METRICS_TOKEN_REQUIRED' });
        await request(app).get('/metrics').set('authorization', `Bearer ${token}x`).expect(401);
        await request(app).get('/metrics').set('authorization', token).expect(401);
        const allowed = await request(app)
          .get('/metrics')
          .set('authorization', `Bearer ${token}`)
          .expect(200);
        expect(allowed.headers['content-type']).toContain('text/plain');
        expect(allowed.headers['cache-control']).toBe('no-store');
        expect(allowed.text).toContain('af_runs_created_total 1');
        // A short or missing token lets nobody in, and rotation needs no restart.
        writeFileSync(tokenPath, 'short');
        await request(app).get('/metrics').set('authorization', 'Bearer short').expect(401);
        rmSync(tokenPath);
        await request(app).get('/metrics').set('authorization', `Bearer ${token}`).expect(401);
        // Without the setting there is no route at all.
        const plain = express();
        configureMetricsRoute(plain, telemetry, undefined);
        await request(plain).get('/metrics').expect(404);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
