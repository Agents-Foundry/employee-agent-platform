// Deterministic run and step state machines (ADR 0008). Shared by the control plane and runtimes.
import type { AgentRunStatus, RunStepStatus, RuntimeEventType } from './execution.js';

export const terminalRunStatuses: readonly AgentRunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
export const activeRunStatuses: readonly AgentRunStatus[] = [
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
];

/** Every legal run transition, whoever performs it. */
export const runTransitions: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  // Only the control plane leaves WAITING_FOR_APPROVAL toward execution, after a human decision.
  WAITING_FOR_APPROVAL: ['QUEUED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const terminalStepStatuses: readonly RunStepStatus[] = [
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
];

export const stepTransitions: Readonly<Record<RunStepStatus, readonly RunStepStatus[]>> = {
  PENDING: ['RUNNING', 'WAITING_FOR_APPROVAL', 'SKIPPED', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['PENDING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED: [],
  CANCELLED: [],
};

/** Status reason recorded when an approval releases a paused run for runtime pickup. */
export const APPROVAL_GRANTED = 'APPROVAL_GRANTED';
export const APPROVAL_REJECTED = 'APPROVAL_REJECTED';

export function isTerminalRun(status: AgentRunStatus): boolean {
  return terminalRunStatuses.includes(status);
}

export function canTransitionRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return runTransitions[from].includes(to);
}

export function canTransitionStep(from: RunStepStatus, to: RunStepStatus): boolean {
  return stepTransitions[from].includes(to);
}

export type RuntimeEventDecision =
  | { accepted: true; nextStatus: AgentRunStatus }
  | { accepted: false; code: 'RUN_TERMINAL' | 'ILLEGAL_RUN_TRANSITION' | 'RUN_NOT_RUNNING' };

/**
 * Decide whether a runtime-emitted event is legal for a run in `status`.
 * Runtimes can never release a run from WAITING_FOR_APPROVAL; they may only resume a run
 * the control plane re-queued with APPROVAL_GRANTED.
 */
export function decideRuntimeEvent(
  run: { status: AgentRunStatus; statusReason: string | null },
  type: RuntimeEventType,
): RuntimeEventDecision {
  if (isTerminalRun(run.status)) return { accepted: false, code: 'RUN_TERMINAL' };
  const move = (to: AgentRunStatus, when: boolean): RuntimeEventDecision =>
    when && canTransitionRun(run.status, to)
      ? { accepted: true, nextStatus: to }
      : { accepted: false, code: 'ILLEGAL_RUN_TRANSITION' };
  switch (type) {
    case 'run.started':
      return move('RUNNING', run.status === 'QUEUED' && run.statusReason === null);
    case 'run.resumed':
      return move('RUNNING', run.status === 'QUEUED' && run.statusReason === APPROVAL_GRANTED);
    case 'run.paused':
      return move('WAITING_FOR_APPROVAL', run.status === 'RUNNING');
    case 'run.completed':
      return move('COMPLETED', run.status === 'RUNNING');
    case 'run.failed':
      return move('FAILED', true);
    case 'run.cancelled':
      return move('CANCELLED', true);
    default:
      return run.status === 'RUNNING'
        ? { accepted: true, nextStatus: 'RUNNING' }
        : { accepted: false, code: 'RUN_NOT_RUNNING' };
  }
}
