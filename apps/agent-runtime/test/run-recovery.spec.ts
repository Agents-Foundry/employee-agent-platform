import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RuntimeCorrelation } from '@agents-foundry/contracts';
import {
  CheckpointConflict,
  ControlPlaneCheckpointStore,
  type CheckpointStore,
  type RunCheckpoint,
} from '../src/checkpoints.js';
import { ControlPlaneError } from '../src/errors.js';
import { ControlPlaneModelCredentials } from '../src/models/model-gateway.js';
import { ScriptedProvider, type ModelScript } from '../src/models/scripted-provider.js';
import { ArtifactTool } from '../src/tools/artifact-tool.js';
import type { RuntimeTool, ToolExecutionContext } from '../src/tools/runtime-tool.js';
import { FakeControlPlane, correlation, createHost, signedManifest } from './fixtures.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const results = (request: Parameters<ModelScript>[0]) =>
  request.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'tool_result' ? [block] : [])),
  );
const call = (name: string, input: unknown) => ({
  content: [{ type: 'tool_use' as const, id: `toolu_${randomUUID()}`, name, input }],
  stopReason: 'tool_use',
  usage,
});
const report = { name: 'plan.md', type: 'report', mediaType: 'text/markdown', content: '# Plan' };

/** Stores a report, then files an issue, then finishes. Stateless, so any runtime can play it. */
const script: ModelScript = (request) => {
  const seen = results(request);
  if (seen.length === 0) return call('artifact', report);
  if (seen.length === 1) return call('issue-tracker', { title: 'Bug' });
  return {
    content: [{ type: 'text', text: `Done: ${seen.map((item) => item.content).join(' | ')}` }],
    stopReason: 'end_turn',
    usage,
  };
};

/** A governed tool whose effect happens at the control plane, keyed by the request id. */
class IssueTool implements RuntimeTool<{ title: string }> {
  readonly id = 'issue-tracker';
  readonly version = '1.0.0';
  readonly description = 'Files an issue.';
  readonly inputSchema = { type: 'object' };
  runs = 0;
  /** When set, the tool never returns after its effect: the runtime died holding the result. */
  hang: Promise<void> | null = null;
  output = 'created';
  parse(input: unknown) {
    return z.object({ title: z.string() }).strict().parse(input);
  }
  governedAction() {
    return 'jira.issue.create';
  }
  summarize(input: { title: string }) {
    return `Create ${input.title}`;
  }
  async execute(_input: { title: string }, context: ToolExecutionContext) {
    this.runs += 1;
    await context.governedAction!.execute();
    if (this.hang) await this.hang;
    return { output: this.output, artifactIds: [] };
  }
}

const settle = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 400 && !done(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done()).toBe(true);
};

function world() {
  const controlPlane = new FakeControlPlane();
  const subject = correlation();
  const host = (tool: IssueTool, extra: Partial<Parameters<typeof createHost>[0]> = {}) =>
    createHost({
      controlPlane,
      provider: new ScriptedProvider('test-provider', script),
      tools: [new ArtifactTool(), tool],
      checkpoints: new ControlPlaneCheckpointStore(controlPlane),
      ...extra,
    }).host;
  const stepOf = (type: string) =>
    controlPlane.events.filter((event) => event.type === type).at(-1)!.stepId!;
  return { controlPlane, subject, host, stepOf };
}

/** Runtime A: runs the report step, starts the issue step, and stops inside it. */
async function crashInsideIssueStep(context: ReturnType<typeof world>) {
  const { controlPlane, subject, host } = context;
  controlPlane.submit(subject, signedManifest(subject));
  const tool = new IssueTool();
  let release!: () => void;
  tool.hang = new Promise<void>((resolve) => (release = resolve));
  const runtimeA = host(tool);
  await runtimeA.pollOnce();
  await settle(() => controlPlane.executions.length === 1);
  return { runtimeA, tool, release };
}

describe('continuing a run in another runtime (ADR 0032)', () => {
  it('finishes a run its first runtime abandoned, without repeating finished work', async () => {
    const context = world();
    const { controlPlane, subject, host, stepOf } = context;
    const first = await crashInsideIssueStep(context);
    const openStep = stepOf('tool.requested');
    const before = controlPlane.events.length;

    // The lease expired: the control plane hands the run to runtime B.
    controlPlane.recover(subject, [openStep]);
    const second = new IssueTool();
    const runtimeB = host(second);
    await runtimeB.pollOnce();
    await runtimeB.drain();

    const types = controlPlane.types(subject.runId);
    expect(types.at(-1)).toBe('run.completed');
    expect(types.filter((type) => type === 'run.started')).toHaveLength(1);
    // The report was stored once, by runtime A.
    expect(types.filter((type) => type === 'artifact.created')).toHaveLength(1);
    // The issue step was continued under the same identifiers, not started again.
    const after = controlPlane.events.slice(before).map((event) => event.type);
    expect(after.slice(0, 3)).toEqual(['tool.started', 'tool.completed', 'step.completed']);
    expect(controlPlane.events.slice(before)[0]!.stepId).toBe(openStep);
    // Both runtimes asked for the same decision and the same execution: the control plane
    // answers the second from its record.
    expect(controlPlane.actions).toHaveLength(2);
    expect(new Set(controlPlane.actions.map((action) => action.requestId)).size).toBe(1);
    expect(controlPlane.actions[0]).toEqual(controlPlane.actions[1]);
    expect(controlPlane.executions).toHaveLength(2);
    expect(new Set(controlPlane.executions.map((item) => item.requestId)).size).toBe(1);
    expect(second.runs).toBe(1);
    // The model saw both results and was asked each turn once across both runtimes.
    const summary = controlPlane.events.at(-1)!.payload as { summary: string };
    expect(summary.summary).toContain('Stored report');
    expect(summary.summary).toContain('created');
    expect(types.filter((type) => type === 'model.requested')).toHaveLength(3);

    // Runtime A comes back: it is told the run is lost, stops, and records nothing more.
    const total = controlPlane.events.length;
    controlPlane.lost.add(subject.runId);
    controlPlane.rejectEvents = true;
    await first.runtimeA.heartbeatOnce();
    first.release();
    await first.runtimeA.drain();
    expect(controlPlane.events).toHaveLength(total);
  });

  it('never repeats a tool call whose step already ended, even though its output was lost', async () => {
    const context = world();
    const { controlPlane, subject, host } = context;
    await crashInsideIssueStep(context);
    // The step ended at the control plane after the last checkpoint: nothing is open.
    controlPlane.recover(subject, []);
    const second = new IssueTool();
    const runtimeB = host(second);
    await runtimeB.pollOnce();
    await runtimeB.drain();
    expect(second.runs).toBe(0);
    expect(controlPlane.actions).toHaveLength(1);
    expect(controlPlane.executions).toHaveLength(1);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');
    const summary = controlPlane.events.at(-1)!.payload as { summary: string };
    expect(summary.summary).toContain('TOOL_OUTCOME_UNKNOWN');
  });

  it('fails the steps the previous runtime left open and the checkpoint does not know', async () => {
    const context = world();
    const { controlPlane, subject, host, stepOf } = context;
    await crashInsideIssueStep(context);
    const openStep = stepOf('tool.requested');
    const orphan = randomUUID();
    controlPlane.recover(subject, [orphan, openStep]);
    const before = controlPlane.events.length;
    const runtimeB = host(new IssueTool());
    await runtimeB.pollOnce();
    await runtimeB.drain();
    expect(controlPlane.events[before]).toMatchObject({
      type: 'step.failed',
      stepId: orphan,
      payload: { error: { code: 'RUNTIME_RECOVERED' } },
    });
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');
  });

  it('resumes an approved run in a different runtime than the one that paused it', async () => {
    const { controlPlane, subject, host } = world();
    const approvalId = randomUUID();
    controlPlane.decide = (request) => ({
      requestId: request.requestId,
      decision: 'APPROVAL_REQUIRED',
      risk: 'MEDIUM',
      reason: 'needs approval',
      approvalId,
    });
    controlPlane.submit(subject, signedManifest(subject));
    const first = new IssueTool();
    const runtimeA = host(first);
    await runtimeA.pollOnce();
    await runtimeA.drain();
    expect(first.runs).toBe(0);
    expect(controlPlane.checkpoints.get(subject.runId)!.binding.approvalId).toBe(approvalId);

    controlPlane.resume(subject, approvalId);
    const second = new IssueTool();
    const runtimeB = host(second);
    await runtimeB.pollOnce();
    await runtimeB.drain();
    expect(second.runs).toBe(1);
    // The decision was not asked for again; the paused request is the one executed.
    expect(controlPlane.actions).toHaveLength(1);
    expect(controlPlane.executions[0]!.requestId).toBe(controlPlane.actions[0]!.requestId);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');

    // An approval for something else does not release it.
    const other = world();
    other.controlPlane.decide = controlPlane.decide;
    other.controlPlane.submit(other.subject, signedManifest(other.subject));
    await other
      .host(new IssueTool())
      .pollOnce()
      .then(() => undefined);
    await settle(
      () =>
        other.controlPlane.checkpoints.get(other.subject.runId)?.binding.approvalId === approvalId,
    );
    other.controlPlane.resume(other.subject, randomUUID());
    const mismatched = new IssueTool();
    const runtimeC = other.host(mismatched);
    await runtimeC.pollOnce();
    await runtimeC.drain();
    expect(mismatched.runs).toBe(0);
    expect(other.controlPlane.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'RUNTIME_CHECKPOINT_INVALID' } },
    });
  });

  it('resumes from the stored decision when the pause itself was never checkpointed', async () => {
    const { controlPlane, subject } = world();
    const approvalId = randomUUID();
    controlPlane.decide = (request) => ({
      requestId: request.requestId,
      decision: 'APPROVAL_REQUIRED',
      risk: 'MEDIUM',
      reason: 'needs approval',
      approvalId,
    });
    controlPlane.submit(subject, signedManifest(subject));
    const durable = new ControlPlaneCheckpointStore(controlPlane);
    // Runtime A dies between the decision and the pause checkpoint.
    const dying: CheckpointStore = {
      save: (checkpoint: RunCheckpoint) =>
        checkpoint.approvalId
          ? Promise.reject(new ControlPlaneError(503, 'UNAVAILABLE'))
          : durable.save(checkpoint),
      load: (run: RuntimeCorrelation) => durable.load(run),
      delete: () => durable.delete(),
    };
    const provider = () => new ScriptedProvider('test-provider', script);
    const runtimeA = createHost({
      controlPlane,
      provider: provider(),
      tools: [new ArtifactTool(), new IssueTool()],
      checkpoints: dying,
    }).host;
    await runtimeA.pollOnce();
    await runtimeA.drain();
    expect(controlPlane.checkpoints.get(subject.runId)!.binding.approvalId).toBeNull();

    controlPlane.resume(subject, approvalId);
    const tool = new IssueTool();
    const runtimeB = createHost({
      controlPlane,
      provider: provider(),
      tools: [new ArtifactTool(), tool],
      checkpoints: durable,
    }).host;
    await runtimeB.pollOnce();
    await runtimeB.drain();
    expect(tool.runs).toBe(1);
    expect(new Set(controlPlane.actions.map((action) => action.requestId)).size).toBe(1);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');
  }, 20_000);

  it('stops a runtime whose checkpoint is stale without failing the run', async () => {
    const { controlPlane, subject } = world();
    controlPlane.submit(subject, signedManifest(subject));
    const durable = new ControlPlaneCheckpointStore(controlPlane);
    let saves = 0;
    const overtaken: CheckpointStore = {
      save: (checkpoint: RunCheckpoint) =>
        (saves += 1) >= 3 ? Promise.reject(new CheckpointConflict()) : durable.save(checkpoint),
      load: (run: RuntimeCorrelation) => durable.load(run),
      delete: () => durable.delete(),
    };
    const tool = new IssueTool();
    const { host } = createHost({
      controlPlane,
      provider: new ScriptedProvider('test-provider', script),
      tools: [new ArtifactTool(), tool],
      checkpoints: overtaken,
    });
    await host.pollOnce();
    await host.drain();
    const types = controlPlane.types(subject.runId);
    expect(types).not.toContain('run.failed');
    expect(types).not.toContain('run.completed');
    expect(tool.runs).toBe(0);
    // The control plane refuses the same thing itself.
    const stored = controlPlane.checkpoints.get(subject.runId)!;
    await expect(controlPlane.saveCheckpoint(stored)).rejects.toMatchObject({
      code: 'CHECKPOINT_VERSION_CONFLICT',
    });
  });

  it('fails closed on a corrupted checkpoint, a foreign one and a missing one', async () => {
    for (const damage of ['body', 'digest', 'binding', 'manifest', 'missing'] as const) {
      const context = world();
      const { controlPlane, subject, host, stepOf } = context;
      await crashInsideIssueStep(context);
      const stored = controlPlane.checkpoints.get(subject.runId)!;
      const rewrite = (change: (checkpoint: RunCheckpoint) => void) => {
        const checkpoint = JSON.parse(stored.body) as RunCheckpoint;
        change(checkpoint);
        const body = JSON.stringify(checkpoint);
        return { body, sha256: createHash('sha256').update(body).digest('hex') };
      };
      if (damage === 'body')
        controlPlane.checkpoints.set(subject.runId, {
          ...stored,
          body: stored.body.replace('Bug', 'Bag'),
        });
      if (damage === 'digest')
        controlPlane.checkpoints.set(subject.runId, {
          ...stored,
          ...rewrite((checkpoint) => (checkpoint.kernelState = { version: 2, forged: true })),
          binding: { ...stored.binding, stepId: null },
        });
      if (damage === 'binding')
        controlPlane.checkpoints.set(subject.runId, {
          ...stored,
          binding: { ...stored.binding, manifestDigest: 'a'.repeat(64) },
        });
      if (damage === 'manifest') {
        // A checkpoint carrying another agent's manifest, however well formed.
        const other = { ...subject, agentId: 'agent_other' };
        controlPlane.checkpoints.set(subject.runId, {
          ...stored,
          ...rewrite((checkpoint) => (checkpoint.manifest = signedManifest(other))),
        });
      }
      if (damage === 'missing') controlPlane.checkpoints.delete(subject.runId);
      controlPlane.recover(subject, [stepOf('tool.requested')]);
      const tool = new IssueTool();
      const runtimeB = host(tool);
      await runtimeB.pollOnce();
      await runtimeB.drain();
      expect(tool.runs, damage).toBe(0);
      expect(controlPlane.executions, damage).toHaveLength(1);
      const last = controlPlane.events.at(-1)!;
      expect(last.type, damage).toBe('run.failed');
      expect((last.payload as { error: { code: string } }).error.code, damage).toBe(
        damage === 'missing' ? 'RUNTIME_CHECKPOINT_MISSING' : 'RUNTIME_CHECKPOINT_INVALID',
      );
    }
  }, 30_000);

  it('never writes a model credential into a checkpoint', async () => {
    const { controlPlane, subject } = world();
    const key = 'sk-organization-model-key-0123456789';
    controlPlane.modelKey = key;
    controlPlane.submit(subject, signedManifest(subject));
    // A tool that echoes the credential back, as a careless integration might.
    const leaky = new IssueTool();
    leaky.output = `debug: authorization=${key}`;
    const { host } = createHost({
      controlPlane,
      provider: new ScriptedProvider('test-provider', script),
      tools: [new ArtifactTool(), leaky],
      checkpoints: new ControlPlaneCheckpointStore(controlPlane),
      modelCredentials: (run) =>
        new ControlPlaneModelCredentials(async (provider) =>
          controlPlane.modelCredential({
            protocol: 'agents-foundry/runtime/v1',
            correlation: run,
            provider,
          }),
        ),
    });
    await host.pollOnce();
    await host.drain();
    expect(controlPlane.credentialRequests.length).toBeGreaterThan(0);
    expect(controlPlane.events.at(-1)).toMatchObject({
      type: 'run.failed',
      payload: { error: { code: 'RUNTIME_CHECKPOINT_SECRET' } },
    });
    expect(controlPlane.checkpointSaves.length).toBeGreaterThan(0);
    expect(JSON.stringify(controlPlane.checkpointSaves)).not.toContain(key);
    expect(JSON.stringify(controlPlane.events)).not.toContain(key);
  });

  it('renews only the runs it is executing', async () => {
    const context = world();
    const { controlPlane, subject } = context;
    const idle = context.host(new IssueTool());
    await idle.heartbeatOnce();
    expect(controlPlane.heartbeats).toEqual([]);
    const { runtimeA, release } = await crashInsideIssueStep(context);
    await runtimeA.heartbeatOnce();
    expect(controlPlane.heartbeats).toEqual([[subject.runId]]);
    controlPlane.rejectEvents = true;
    release();
    await runtimeA.drain();
  });
});
