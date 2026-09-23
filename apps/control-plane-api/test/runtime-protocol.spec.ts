import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_RUNTIME_MESSAGE_BYTES,
  parseRuntimeCommand,
  parseRuntimeEvent,
  parseSignedManifest,
} from '../../../packages/contracts/src/runtime/v1/schemas.js';
import {
  APPROVAL_GRANTED,
  canTransitionRun,
  decideRuntimeEvent,
} from '../../../packages/contracts/src/run-lifecycle.js';
import { artifactStorageReferencePattern } from '../../../packages/contracts/src/artifacts.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';

const runId = randomUUID();
const threadId = randomUUID();
const correlation = {
  organizationId: 'org_agents_foundry',
  employeeId: 'employee_qa_demo',
  agentId: randomUUID(),
  threadId,
  runId,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'agents-foundry/runtime/v1',
    eventId: randomUUID(),
    runId,
    threadId,
    sequence: 1,
    type: 'run.started',
    occurredAt: new Date().toISOString(),
    correlation,
    payload: { runtimeSessionId: randomUUID(), kernel: 'test-kernel' },
    ...overrides,
  };
}

function code(work: () => unknown): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('agents-foundry/runtime/v1 events', () => {
  it('parses a valid event and preserves its typed payload', () => {
    const parsed = parseRuntimeEvent(event());
    expect(parsed.type).toBe('run.started');
    expect(parsed.protocol).toBe('agents-foundry/runtime/v1');
  });

  it('rejects other protocol versions, unknown types and control-plane-only types', () => {
    expect(code(() => parseRuntimeEvent(event({ protocol: 'agents-foundry/runtime/v2' })))).toBe(
      'PROTOCOL_VERSION_UNSUPPORTED',
    );
    expect(code(() => parseRuntimeEvent(event({ type: 'runtime.teleported' })))).toBe(
      'RUNTIME_EVENT_INVALID',
    );
    // A runtime can never record approvals or user messages on its own behalf.
    for (const type of ['approval.approved', 'approval.requested', 'user.message', 'run.created'])
      expect(code(() => parseRuntimeEvent(event({ type, payload: {} })))).toBe(
        'RUNTIME_EVENT_TYPE_FORBIDDEN',
      );
  });

  it('rejects unknown fields, malformed payloads, and oversized messages', () => {
    expect(code(() => parseRuntimeEvent({ ...event(), extra: true }))).toBe(
      'RUNTIME_EVENT_INVALID',
    );
    expect(
      code(() =>
        parseRuntimeEvent(event({ payload: { runtimeSessionId: 'x', kernel: 'test-kernel' } })),
      ),
    ).toBe('RUNTIME_EVENT_INVALID');
    expect(
      code(() =>
        parseRuntimeEvent(
          event({ payload: { runtimeSessionId: randomUUID(), kernel: 'k', secret: 'sk-live' } }),
        ),
      ),
    ).toBe('RUNTIME_EVENT_INVALID');
    expect(
      code(() =>
        parseRuntimeEvent(
          event({
            type: 'agent.message',
            payload: { content: 'x'.repeat(MAX_RUNTIME_MESSAGE_BYTES) },
          }),
        ),
      ),
    ).toBe('RUNTIME_MESSAGE_TOO_LARGE');
    expect(code(() => parseRuntimeEvent(null))).toBe('RUNTIME_EVENT_INVALID');
    expect(code(() => parseRuntimeEvent(event({ sequence: 0 })))).toBe('RUNTIME_EVENT_INVALID');
  });

  it('requires step ids for step events and consistent correlation', () => {
    expect(
      code(() =>
        parseRuntimeEvent(event({ type: 'step.started', payload: { kind: 'TOOL', title: 'Run' } })),
      ),
    ).toBe('RUNTIME_EVENT_INVALID');
    expect(
      code(() =>
        parseRuntimeEvent(event({ correlation: { ...correlation, runId: randomUUID() } })),
      ),
    ).toBe('RUNTIME_EVENT_INVALID');
    const stepId = randomUUID();
    expect(
      parseRuntimeEvent(
        event({ type: 'step.started', stepId, payload: { kind: 'TOOL', title: 'Run tests' } }),
      ).stepId,
    ).toBe(stepId);
  });

  it('accepts only opaque artifact storage references', () => {
    const artifact = (storageReference: string) =>
      event({
        type: 'artifact.created',
        payload: {
          artifact: {
            id: randomUUID(),
            type: 'screenshot',
            mediaType: 'image/png',
            name: 'home.png',
            storageReference,
            checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
            sizeBytes: 10,
            retentionPolicy: 'STANDARD_30D',
          },
        },
      });
    expect(parseRuntimeEvent(artifact('artifact://local-dev/org/run/home.png')).type).toBe(
      'artifact.created',
    );
    for (const bad of [
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'https://user:pw@example.com/a.png',
      'artifact://store/../other-tenant/a.png',
      'artifact://Store/a.png',
    ]) {
      expect(artifactStorageReferencePattern.test(bad)).toBe(false);
      expect(code(() => parseRuntimeEvent(artifact(bad)))).toBe('RUNTIME_EVENT_INVALID');
    }
  });
});

describe('agents-foundry/runtime/v1 commands', () => {
  it('rejects unsupported versions and run/correlation mismatches', () => {
    const cancel = {
      protocol: 'agents-foundry/runtime/v1',
      type: 'run.cancel',
      commandId: randomUUID(),
      issuedAt: new Date().toISOString(),
      correlation,
      runId,
      reason: 'Employee cancelled',
    };
    expect(parseRuntimeCommand(cancel).type).toBe('run.cancel');
    expect(code(() => parseRuntimeCommand({ ...cancel, protocol: 'x' }))).toBe(
      'PROTOCOL_VERSION_UNSUPPORTED',
    );
    expect(code(() => parseRuntimeCommand({ ...cancel, runId: randomUUID() }))).toBe(
      'RUNTIME_COMMAND_INVALID',
    );
    expect(code(() => parseRuntimeCommand({ ...cancel, type: 'run.escalate' }))).toBe(
      'RUNTIME_COMMAND_INVALID',
    );
  });
});

describe('signed manifest structure', () => {
  it('fails closed on unknown or missing manifest versions', () => {
    expect(code(() => parseSignedManifest({ payload: { apiVersion: 'agents-foundry/v3' } }))).toBe(
      'MANIFEST_INVALID',
    );
    expect(code(() => parseSignedManifest({}))).toBe('MANIFEST_INVALID');
    expect(() =>
      manifestSubject({ apiVersion: 'agents-foundry/v9' } as unknown as Parameters<
        typeof manifestSubject
      >[0]),
    ).toThrow('UNSUPPORTED_MANIFEST_VERSION');
  });
});

describe('run lifecycle', () => {
  it('never lets a runtime release a run that is waiting for approval', () => {
    const waiting = { status: 'WAITING_FOR_APPROVAL' as const, statusReason: 'APPROVAL_REQUIRED' };
    expect(decideRuntimeEvent(waiting, 'run.resumed')).toEqual({
      accepted: false,
      code: 'ILLEGAL_RUN_TRANSITION',
    });
    expect(decideRuntimeEvent(waiting, 'run.started').accepted).toBe(false);
    expect(decideRuntimeEvent(waiting, 'tool.started')).toEqual({
      accepted: false,
      code: 'RUN_NOT_RUNNING',
    });
    // The runtime may still give up or acknowledge cancellation while paused.
    expect(decideRuntimeEvent(waiting, 'run.cancelled')).toEqual({
      accepted: true,
      nextStatus: 'CANCELLED',
    });
  });

  it('resumes only runs the control plane re-queued after approval', () => {
    expect(
      decideRuntimeEvent({ status: 'QUEUED', statusReason: null }, 'run.resumed').accepted,
    ).toBe(false);
    expect(
      decideRuntimeEvent({ status: 'QUEUED', statusReason: APPROVAL_GRANTED }, 'run.resumed'),
    ).toEqual({ accepted: true, nextStatus: 'RUNNING' });
    expect(
      decideRuntimeEvent({ status: 'QUEUED', statusReason: APPROVAL_GRANTED }, 'run.started')
        .accepted,
    ).toBe(false);
  });

  it('keeps terminal runs terminal', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(decideRuntimeEvent({ status, statusReason: null }, 'run.started')).toEqual({
        accepted: false,
        code: 'RUN_TERMINAL',
      });
      expect(canTransitionRun(status, 'RUNNING')).toBe(false);
    }
    expect(canTransitionRun('WAITING_FOR_APPROVAL', 'RUNNING')).toBe(false);
  });
});
