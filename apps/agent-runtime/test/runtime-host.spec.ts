import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RuntimeEventEnvelope } from '@agents-foundry/contracts';
import { ScriptedProvider, type ModelScript } from '../src/models/scripted-provider.js';
import { EnvironmentCredentialBroker } from '../src/models/model-gateway.js';
import { ArtifactTool } from '../src/tools/artifact-tool.js';
import type { RuntimeTool } from '../src/tools/runtime-tool.js';
import { FakeControlPlane, correlation, createHost, signedManifest } from './fixtures.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const finish = (text = 'Done.') => ({
  content: [{ type: 'text' as const, text }],
  stopReason: 'end_turn',
  usage,
});
const callTool = (name: string, input: unknown) => ({
  content: [{ type: 'tool_use' as const, id: `toolu_${randomUUID()}`, name, input }],
  stopReason: 'tool_use',
  usage,
});
/** Calls the given tool once, then finishes. */
const once =
  (name: string, input: unknown): ModelScript =>
  (request) =>
    request.messages.some((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    )
      ? finish()
      : callTool(name, input);

class GovernedTool implements RuntimeTool<{ title: string }> {
  readonly id = 'issue-tracker';
  readonly version = '1.0.0';
  readonly description = 'Governed test tool.';
  readonly inputSchema = { type: 'object' };
  runs = 0;
  parse(input: unknown) {
    return z.object({ title: z.string() }).strict().parse(input);
  }
  governedAction() {
    return 'jira.issue.create';
  }
  summarize(input: { title: string }) {
    return `Create ${input.title}`;
  }
  async execute() {
    this.runs += 1;
    return { output: 'created', artifactIds: [] };
  }
}

function payloadOf(events: RuntimeEventEnvelope[], type: string) {
  return events.find((event) => event.type === type)?.payload as
    Record<string, unknown> | undefined;
}

describe('runtime host and native kernel', () => {
  it('completes a run that stores an artifact, emitting a valid contiguous event stream', async () => {
    const controlPlane = new FakeControlPlane();
    const subject = correlation();
    controlPlane.submit(subject, signedManifest(subject));
    const { host, artifacts } = createHost({
      controlPlane,
      provider: ScriptedProvider.demo('test-provider'),
    });
    expect(await host.pollOnce()).toBe(true);
    await host.drain();
    expect(controlPlane.types(subject.runId)).toEqual([
      'run.started',
      'step.started',
      'model.requested',
      'model.responded',
      'agent.message',
      'step.completed',
      'step.started',
      'tool.requested',
      'tool.started',
      'artifact.created',
      'tool.completed',
      'step.completed',
      'step.started',
      'model.requested',
      'model.responded',
      'agent.message',
      'step.completed',
      'run.completed',
    ]);
    expect(artifacts.items.size).toBe(1);
    const artifact = payloadOf(controlPlane.events, 'artifact.created')!['artifact'] as {
      id: string;
    };
    expect(payloadOf(controlPlane.events, 'run.completed')).toMatchObject({
      artifactIds: [artifact.id],
    });
    // Ungoverned local tools never ask the control plane.
    expect(controlPlane.actions).toEqual([]);
    expect(await host.pollOnce()).toBe(false);
  });

  it('pauses on an approval, checkpoints, and resumes without replaying earlier work', async () => {
    const controlPlane = new FakeControlPlane();
    const subject = correlation();
    const approvalId = randomUUID();
    controlPlane.decide = (request) => ({
      requestId: request.requestId,
      decision: 'APPROVAL_REQUIRED',
      risk: 'MEDIUM',
      reason: 'needs approval',
      approvalId,
    });
    const governed = new GovernedTool();
    const turns: number[] = [];
    const provider = new ScriptedProvider('test-provider', (request, turn) => {
      turns.push(turn);
      return once('issue-tracker', { title: 'Bug' })(request, turn);
    });
    controlPlane.submit(subject, signedManifest(subject));
    const { host, checkpoints } = createHost({ controlPlane, provider, tools: [governed] });
    await host.pollOnce();
    await host.drain();
    expect(governed.runs).toBe(0);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('tool.requested');
    expect(controlPlane.actions).toHaveLength(1);
    expect(controlPlane.actions[0]).toMatchObject({
      action: 'jira.issue.create',
      toolId: 'issue-tracker',
      summary: 'Create Bug',
      correlation: { runId: subject.runId, stepId: controlPlane.events.at(-1)!.stepId },
    });
    const checkpoint = await checkpoints.load(subject.runId);
    expect(checkpoint).toMatchObject({ approvalId, kernelId: 'native-v1' });

    controlPlane.resume(subject, approvalId);
    await host.pollOnce();
    await host.drain();
    expect(governed.runs).toBe(1);
    expect(controlPlane.actions).toHaveLength(1);
    expect(turns).toEqual([1, 2]);
    const after = controlPlane.types(subject.runId);
    expect(after.slice(after.indexOf('run.resumed'))).toEqual([
      'run.resumed',
      'tool.started',
      'tool.completed',
      'step.completed',
      'step.started',
      'model.requested',
      'model.responded',
      'agent.message',
      'step.completed',
      'run.completed',
    ]);
    expect(await checkpoints.load(subject.runId)).toBeNull();
  });

  it('reports denied actions, unavailable tools and invalid input to the model without executing', async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.decide = (request) => ({
      requestId: request.requestId,
      decision: 'DENIED',
      risk: 'CRITICAL',
      reason: 'Unknown actions are denied.',
    });
    const governed = new GovernedTool();
    const seen: string[] = [];
    const script: ModelScript = (request) => {
      const results = request.messages.flatMap((message) =>
        message.content.flatMap((block) => (block.type === 'tool_result' ? [block] : [])),
      );
      if (results.length)
        seen.push(
          ...results.map((result) => (result.type === 'tool_result' ? result.content : '')),
        );
      if (results.length === 0) return callTool('issue-tracker', { title: 'x' });
      if (results.length === 1) return callTool('shell', { command: 'rm -rf /' });
      if (results.length === 2) return callTool('artifact', { name: '../escape', content: 'x' });
      return finish();
    };
    const subject = correlation();
    controlPlane.submit(subject, signedManifest(subject));
    const { host, artifacts } = createHost({
      controlPlane,
      provider: new ScriptedProvider('test-provider', script),
      tools: [governed, new ArtifactTool()],
    });
    await host.pollOnce();
    await host.drain();
    expect(governed.runs).toBe(0);
    expect(artifacts.items.size).toBe(0);
    expect(seen.at(-1)).toMatch(/^TOOL_INPUT_INVALID/);
    expect(seen).toContain('ACTION_DENIED: Unknown actions are denied.');
    expect(seen).toContain('Tool shell is not available.');
    const failures = controlPlane.events
      .filter((event) => event.type === 'step.failed')
      .map((event) => (event.payload as { error: { code: string } }).error.code);
    expect(failures).toEqual(['ACTION_DENIED', 'TOOL_NOT_AVAILABLE', 'TOOL_INPUT_INVALID']);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');
  });

  it('never exposes tools the manifest does not grant', async () => {
    const controlPlane = new FakeControlPlane();
    const subject = correlation();
    const offered: string[][] = [];
    controlPlane.submit(
      subject,
      signedManifest(subject, (payload) => (payload.tools = ['repository'])),
    );
    const { host } = createHost({
      controlPlane,
      provider: new ScriptedProvider('test-provider', (request) => {
        offered.push(request.tools.map((tool) => tool.name));
        return finish();
      }),
      tools: [new ArtifactTool(), new GovernedTool()],
    });
    await host.pollOnce();
    await host.drain();
    expect(offered).toEqual([[]]);
  });

  it('fails closed on manifests with a bad signature, key, subject or profile', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const cases = [
      (subject: ReturnType<typeof correlation>) => signedManifest(subject, () => undefined, other),
      (subject: ReturnType<typeof correlation>) =>
        signedManifest(subject, (payload) => (payload.metadata.employeeId = 'someone_else')),
      (subject: ReturnType<typeof correlation>) =>
        signedManifest(subject, (payload) => (payload.runtime.profile = 'other-profile')),
      (subject: ReturnType<typeof correlation>) => {
        const manifest = signedManifest(subject);
        manifest.payload.tools.push('shell');
        return manifest;
      },
    ];
    for (const build of cases) {
      const controlPlane = new FakeControlPlane();
      const subject = correlation();
      controlPlane.submit(subject, build(subject));
      let called = false;
      const { host } = createHost({
        controlPlane,
        provider: new ScriptedProvider('test-provider', () => {
          called = true;
          return finish();
        }),
      });
      await host.pollOnce();
      await host.drain();
      expect(controlPlane.types(subject.runId)).toEqual(['run.started', 'run.failed']);
      expect(payloadOf(controlPlane.events, 'run.failed')).toMatchObject({
        error: { code: 'MANIFEST_INVALID' },
        retryable: false,
      });
      expect(called).toBe(false);
    }
  });

  it('fails closed on missing model providers and employee-held credentials', async () => {
    const byok = new FakeControlPlane();
    const subject = correlation();
    byok.submit(
      subject,
      signedManifest(subject, (payload) => (payload.model.credentialMode = 'EMPLOYEE_BYOK')),
    );
    const first = createHost({
      controlPlane: byok,
      provider: ScriptedProvider.demo('test-provider'),
      credentials: new EnvironmentCredentialBroker({ AF_MODEL_API_KEY_TEST_PROVIDER: 'org-key' }),
    });
    await first.host.pollOnce();
    await first.host.drain();
    expect(payloadOf(byok.events, 'run.failed')).toMatchObject({
      error: { code: 'MODEL_CREDENTIAL_UNAVAILABLE' },
    });

    const missing = new FakeControlPlane();
    const second = correlation();
    missing.submit(
      second,
      signedManifest(second, (payload) => (payload.model.provider = 'nowhere')),
    );
    const other = createHost({
      controlPlane: missing,
      provider: ScriptedProvider.demo('test-provider'),
    });
    await other.host.pollOnce();
    await other.host.drain();
    expect(payloadOf(missing.events, 'run.failed')).toMatchObject({
      error: { code: 'MODEL_PROVIDER_UNAVAILABLE' },
    });
    expect(JSON.stringify([...byok.events, ...missing.events])).not.toContain('org-key');
  });

  it('bounds the loop and fails when the checkpoint for a resume is missing', async () => {
    const controlPlane = new FakeControlPlane();
    const looping = correlation();
    controlPlane.submit(looping, signedManifest(looping));
    const { host } = createHost({
      controlPlane,
      maxTurns: 2,
      provider: new ScriptedProvider('test-provider', () =>
        callTool('artifact', {
          name: `a-${randomUUID()}.md`,
          type: 'log',
          mediaType: 'text/plain',
          content: 'x',
        }),
      ),
    });
    await host.pollOnce();
    await host.drain();
    expect(payloadOf(controlPlane.events, 'run.failed')).toMatchObject({
      error: { code: 'MAX_TURNS_EXCEEDED' },
    });

    const orphan = correlation();
    controlPlane.sequences.set(orphan.runId, 7);
    controlPlane.resume(orphan, randomUUID());
    await host.pollOnce();
    await host.drain();
    expect(controlPlane.types(orphan.runId)).toEqual(['run.resumed', 'run.failed']);
    expect(controlPlane.events.find((event) => event.runId === orphan.runId)!.sequence).toBe(8);
    expect(
      controlPlane.events.filter((event) => event.runId === orphan.runId).at(-1)!.payload,
    ).toMatchObject({ error: { code: 'RUNTIME_CHECKPOINT_MISSING' } });
  });

  it('aborts an in-flight run on run.cancel and stops quietly when history is refused', async () => {
    const controlPlane = new FakeControlPlane();
    const subject = correlation();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const slow: RuntimeTool<unknown> = {
      id: 'issue-tracker',
      version: '1.0.0',
      description: 'slow',
      inputSchema: { type: 'object' },
      parse: (input) => input,
      governedAction: () => null,
      summarize: () => 'slow',
      execute: async (_input, context) => {
        await blocked;
        context.signal.throwIfAborted();
        return { output: 'late', artifactIds: [] };
      },
    };
    controlPlane.submit(subject, signedManifest(subject));
    const { host } = createHost({
      controlPlane,
      provider: new ScriptedProvider('test-provider', once('issue-tracker', {})),
      tools: [slow],
    });
    await host.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.activeRuns).toBe(1);
    controlPlane.claims.push({
      command: {
        protocol: 'agents-foundry/runtime/v1',
        type: 'run.cancel',
        commandId: randomUUID(),
        issuedAt: new Date().toISOString(),
        correlation: subject,
        runId: subject.runId,
        reason: 'CANCELLED_BY_EMPLOYEE',
      },
      lease: {
        sessionId: randomUUID(),
        runtimeSequence: 0,
        leaseExpiresAt: new Date().toISOString(),
      },
    });
    await host.pollOnce();
    controlPlane.rejectEvents = true;
    release();
    await host.drain();
    expect(host.activeRuns).toBe(0);
    expect(controlPlane.types(subject.runId)).not.toContain('tool.completed');
    expect(controlPlane.types(subject.runId)).not.toContain('run.completed');
  });
});
