import { describe, expect, it } from 'vitest';
import type { RuntimeEventEnvelope } from '@agents-foundry/contracts';
import { ControlPlaneError, RuntimeFailure } from '../src/errors.js';
import { estimateInputTokens, type ModelProvider } from '../src/models/model-gateway.js';
import { ScriptedProvider } from '../src/models/scripted-provider.js';
import { FakeControlPlane, correlation, createHost, signedManifest } from './fixtures.js';

// Model spending limits at the runtime (ADR 0021): the host meters every model call of a run.

const failure = (events: RuntimeEventEnvelope[]) =>
  events.find((event) => event.type === 'run.failed')?.payload as
    { error: { code: string }; retryable: boolean } | undefined;

const counting = (usage = { inputTokens: 700, outputTokens: 30 }) => {
  const maxTokens: number[] = [];
  const provider = new ScriptedProvider('test-provider', (request) => {
    maxTokens.push(request.maxTokens);
    return { content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn', usage };
  });
  return { provider, maxTokens };
};

async function runOnce(controlPlane: FakeControlPlane, provider: ModelProvider) {
  const subject = correlation();
  controlPlane.submit(subject, signedManifest(subject));
  const { host } = createHost({ controlPlane, provider });
  await host.pollOnce();
  await host.drain();
  return subject;
}

describe('model metering', () => {
  it('reserves before each call, asks for no more than reserved, and settles the reported usage', async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.reserve = (request) => ({
      reservationId: request.reservationId,
      decision: 'ALLOWED',
      maxOutputTokens: 1000,
    });
    const { provider, maxTokens } = counting();
    const subject = await runOnce(controlPlane, provider);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');
    expect(maxTokens).toEqual([1000]);
    const [reservation] = controlPlane.reservations;
    expect(reservation).toMatchObject({
      protocol: 'agents-foundry/runtime/v1',
      correlation: subject,
      provider: 'test-provider',
      model: 'test-model',
      maxOutputTokens: 4096,
    });
    expect(reservation!.estimatedInputTokens).toBeGreaterThan(100);
    expect(controlPlane.settlements).toEqual([
      {
        protocol: 'agents-foundry/runtime/v1',
        reservationId: reservation!.reservationId,
        correlation: subject,
        inputTokens: 700,
        outputTokens: 30,
      },
    ]);
  });

  it('makes no call when the reservation is denied, and fails the run with the reason', async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.reserve = (request) => ({
      reservationId: request.reservationId,
      decision: 'DENIED',
      code: 'MODEL_BUDGET_EXCEEDED',
      reason: "The organization's monthly model token limit is reached.",
    });
    const { provider, maxTokens } = counting();
    const subject = await runOnce(controlPlane, provider);
    expect(maxTokens).toEqual([]);
    expect(controlPlane.settlements).toEqual([]);
    expect(failure(controlPlane.events)).toMatchObject({
      error: { code: 'MODEL_BUDGET_EXCEEDED' },
      retryable: false,
    });
    expect(controlPlane.types(subject.runId)).not.toContain('model.responded');
  });

  it('fails closed when the limit cannot be checked', async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.reserve = () => {
      throw new ControlPlaneError(503, 'HTTP_503');
    };
    const { provider, maxTokens } = counting();
    await runOnce(controlPlane, provider);
    expect(maxTokens).toEqual([]);
    expect(failure(controlPlane.events)).toMatchObject({
      error: { code: 'MODEL_BUDGET_UNAVAILABLE' },
      retryable: true,
    });
  });

  it('settles a provider error as zero usage, but leaves a possibly used reservation counted', async () => {
    const rejected = new FakeControlPlane();
    await runOnce(
      rejected,
      new ScriptedProvider('test-provider', () => {
        throw new RuntimeFailure('MODEL_REQUEST_FAILED', 'The model provider returned HTTP 400.');
      }),
    );
    expect(rejected.settlements.map((s) => [s.inputTokens, s.outputTokens])).toEqual([[0, 0]]);

    const timedOut = new FakeControlPlane();
    await runOnce(
      timedOut,
      new ScriptedProvider('test-provider', () => {
        throw new Error('socket hang up');
      }),
    );
    expect(timedOut.reservations).toHaveLength(1);
    expect(timedOut.settlements).toEqual([]);
  });

  it('does not fail a finished call when its settlement cannot be delivered', async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.settleModelTokens = async () => {
      throw new ControlPlaneError(503, 'HTTP_503');
    };
    const { provider } = counting();
    const subject = await runOnce(controlPlane, provider);
    expect(controlPlane.types(subject.runId).at(-1)).toBe('run.completed');
  });

  it('estimates the prompt conservatively from everything sent', () => {
    const small = estimateInputTokens({ system: 'x', messages: [], tools: [] });
    const large = estimateInputTokens({
      system: 'x'.repeat(3000),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(3000) }] }],
      tools: [{ name: 't', description: 'z'.repeat(3000), inputSchema: {} }],
    });
    expect(small).toBeLessThan(10);
    expect(large).toBeGreaterThanOrEqual(3000);
  });
});
