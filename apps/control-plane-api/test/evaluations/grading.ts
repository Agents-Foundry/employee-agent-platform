/**
 * Deterministic grading of a model-quality run (ADR 0020), from what actually happened: the
 * conversation the model had with its tools, the run's final status and the control-plane
 * actions that reached an external system.
 */
import type { QualityCheck, QualityCriterion } from '@agents-foundry/contracts';
import type { ModelMessage } from '../../../agent-runtime/src/models/model-gateway.js';

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  /** The tool result the model saw; null if the run stopped before the call finished. */
  result: string | null;
  isError: boolean;
}

export interface RunFacts {
  calls: ToolCallRecord[];
  runStatus: string;
  executedActions: string[];
}

export interface CheckResult {
  id: string;
  kind: QualityCheck['kind'];
  weight: number;
  required: boolean;
  passed: boolean;
}

export interface CriterionResult {
  id: string;
  weight: number;
  /** 0 to 1. */
  score: number;
  rationale: string;
}

/** Pairs every tool call in the conversation with the result the model saw. */
export function toolCalls(transcript: readonly ModelMessage[]): ToolCallRecord[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const message of transcript)
    for (const block of message.content)
      if (block.type === 'tool_result')
        results.set(block.toolUseId, { content: block.content, isError: block.isError });
  return transcript.flatMap((message) =>
    message.content.flatMap((block) => {
      if (block.type !== 'tool_use') return [];
      const result = results.get(block.id);
      const input =
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
      return [
        {
          tool: block.name,
          input,
          result: result?.content ?? null,
          isError: result?.isError ?? true,
        },
      ];
    }),
  );
}

/** The model's final words: the text of the last assistant message. */
export function finalMessage(transcript: readonly ModelMessage[]): string {
  const last = [...transcript].reverse().find((message) => message.role === 'assistant');
  return (last?.content ?? [])
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

const includesAll = (text: unknown, needles: readonly string[] = []) =>
  typeof text === 'string' &&
  needles.every((needle) => text.toLowerCase().includes(needle.toLowerCase()));

/** A check passes on a successful call only: a denied or failed attempt does not count. */
function passes(check: QualityCheck, facts: RunFacts): boolean {
  const succeeded = facts.calls.filter((call) => !call.isError && call.result !== null);
  switch (check.kind) {
    case 'tool-called':
      return succeeded.some((call) => call.tool === check.tool);
    case 'tool-not-called':
      return !facts.calls.some((call) => call.tool === check.tool);
    case 'action-executed':
      return facts.executedActions.includes(check.action);
    case 'action-not-executed':
      return !facts.executedActions.includes(check.action);
    case 'no-denials':
      return !facts.calls.some((call) => call.result?.startsWith('ACTION_DENIED:'));
    case 'run-status':
      return facts.runStatus === check.status;
    case 'artifact':
      return succeeded.some(
        (call) =>
          call.tool === 'artifact' &&
          call.input['type'] === check.type &&
          includesAll(call.input['content'], check.contains),
      );
    case 'file-written':
      return succeeded.some(
        (call) =>
          call.tool === 'code-editor' &&
          call.input['kind'] === 'file.write' &&
          typeof call.input['path'] === 'string' &&
          call.input['path'].includes(check.pathIncludes) &&
          includesAll(call.input['content'], check.contains),
      );
  }
}

export function gradeChecks(checks: readonly QualityCheck[], facts: RunFacts): CheckResult[] {
  return checks.map((check) => ({
    id: check.id,
    kind: check.kind,
    weight: check.weight,
    required: check.required ?? false,
    passed: passes(check, facts),
  }));
}

/** Weighted score from 0 to 1, and whether the task passed: every gate held and the score met. */
export function overall(
  checks: readonly CheckResult[],
  criteria: readonly CriterionResult[],
  passThreshold: number,
): { score: number; passed: boolean; failedGates: string[] } {
  const total =
    checks.reduce((sum, check) => sum + check.weight, 0) +
    criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const earned =
    checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0) +
    criteria.reduce((sum, criterion) => sum + criterion.weight * criterion.score, 0);
  const score = total ? Math.round((earned / total) * 1000) / 1000 : 0;
  const failedGates = checks.filter((check) => check.required && !check.passed).map((c) => c.id);
  return { score, passed: failedGates.length === 0 && score >= passThreshold, failedGates };
}

/** Criteria the grader could not score count as zero: grading fails closed. */
export function ungraded(rubric: readonly QualityCriterion[], reason: string): CriterionResult[] {
  return rubric.map((criterion) => ({
    id: criterion.id,
    weight: criterion.weight,
    score: 0,
    rationale: reason,
  }));
}
