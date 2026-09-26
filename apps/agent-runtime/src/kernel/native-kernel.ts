import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';
import { RuntimeFailure, asRuntimeFailure } from '../errors.js';
import type { ModelContent, ModelMessage } from '../models/model-gateway.js';
import type { RuntimeTool } from '../tools/runtime-tool.js';
import type { AgentKernel, KernelContext, KernelOutcome } from './agent-kernel.js';

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

interface PendingTurn {
  toolUses: ToolUse[];
  results: ModelContent[];
  index: number;
  awaiting: { approvalId: string; stepId: string; toolCallId: string; requestId: string } | null;
}

/** Checkpointed between a pause and its resume. Contains conversation content: keep it local. */
interface NativeKernelState {
  version: 1;
  messages: ModelMessage[];
  turns: number;
  artifactIds: string[];
  turn: PendingTurn | null;
}

const stateSchema = z.object({
  version: z.literal(1),
  messages: z.array(z.any()),
  turns: z.number().int().min(0),
  artifactIds: z.array(z.string()),
  turn: z.any().nullable(),
});

type Step = { kind: 'result'; block: ModelContent } | { kind: 'paused'; approvalId: string };

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalManifest(value)).digest('hex');
}

function safeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60) || 'unknown';
}

export interface NativeKernelOptions {
  maxTurns?: number;
  maxTokens?: number;
}

/**
 * Minimal first-party kernel: a bounded model ⇄ tool loop. Every governed action is decided by
 * the control plane before the tool runs; an approval pause checkpoints the loop mid-turn and
 * resumes it without replaying earlier tool calls.
 */
export class NativeKernel implements AgentKernel {
  readonly id = 'native-v1';
  private readonly maxTurns: number;
  private readonly maxTokens: number;

  constructor(options: NativeKernelOptions = {}) {
    this.maxTurns = options.maxTurns ?? 12;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  async start(context: KernelContext): Promise<KernelOutcome> {
    const state: NativeKernelState = {
      version: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: taskPrompt(context) }] }],
      turns: 0,
      artifactIds: [],
      turn: null,
    };
    return this.loop(context, state);
  }

  async resume(
    context: KernelContext,
    rawState: unknown,
    approval: { approvalId: string; decision: 'APPROVED' | 'REJECTED' },
  ): Promise<KernelOutcome> {
    const parsed = stateSchema.safeParse(rawState);
    if (!parsed.success)
      return this.fail('RUNTIME_CHECKPOINT_INVALID', 'The run checkpoint could not be read.');
    const state = parsed.data as NativeKernelState;
    const awaiting = state.turn?.awaiting;
    if (!awaiting || awaiting.approvalId !== approval.approvalId)
      return this.fail(
        'RUNTIME_APPROVAL_MISMATCH',
        'The approval does not match the paused action.',
      );
    if (approval.decision !== 'APPROVED')
      return this.fail('ACTION_REJECTED', 'The governed action was rejected.');
    return this.loop(context, state);
  }

  private async loop(context: KernelContext, state: NativeKernelState): Promise<KernelOutcome> {
    try {
      while (true) {
        context.signal.throwIfAborted();
        if (state.turn) {
          const paused = await this.runTools(context, state, state.turn);
          if (paused) return paused;
          state.messages.push({ role: 'user', content: state.turn.results });
          state.turn = null;
        }
        if (state.turns >= this.maxTurns)
          return this.fail('MAX_TURNS_EXCEEDED', `The run exceeded ${this.maxTurns} model turns.`);
        state.turns += 1;
        const stepId = randomUUID();
        const profile = context.manifest.payload.model.profile;
        await context.emit(
          'step.started',
          { kind: 'MODEL', title: `Model turn ${state.turns}` },
          stepId,
        );
        await context.emit(
          'model.requested',
          { modelProfile: profile, capability: 'chat' },
          stepId,
        );
        let completion;
        try {
          completion = await context.models.complete(
            context.manifest,
            {
              system: systemPrompt(context),
              messages: state.messages,
              tools: context.tools.map((tool) => ({
                name: tool.id,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
              maxTokens: this.maxTokens,
            },
            context.signal,
          );
        } catch (error) {
          const failure = asRuntimeFailure(error);
          await context.emit('step.failed', { error: failure.toExecutionError() }, stepId);
          return { status: 'FAILED', error: failure };
        }
        const { response, latencyMs } = completion;
        await context.emit(
          'model.responded',
          {
            modelProfile: profile,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            latencyMs,
            finishReason: response.stopReason.slice(0, 40),
          },
          stepId,
        );
        const text = response.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        if (text) await context.emit('agent.message', { content: text.slice(0, 20_000) }, stepId);
        await context.emit('step.completed', {}, stepId);
        state.messages.push({ role: 'assistant', content: response.content });
        const toolUses = response.content.flatMap((block) =>
          block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
        );
        if (toolUses.length === 0)
          return {
            status: 'COMPLETED',
            summary: (text || 'Completed.').slice(0, 4000),
            artifactIds: state.artifactIds,
          };
        state.turn = { toolUses, results: [], index: 0, awaiting: null };
      }
    } catch (error) {
      return { status: 'FAILED', error: asRuntimeFailure(error) };
    }
  }

  /** Runs the turn's remaining tool calls; returns a pause outcome if one needs approval. */
  private async runTools(
    context: KernelContext,
    state: NativeKernelState,
    turn: PendingTurn,
  ): Promise<KernelOutcome | null> {
    while (turn.index < turn.toolUses.length) {
      const use = turn.toolUses[turn.index]!;
      const step = await this.runTool(context, state, turn, use);
      if (step.kind === 'paused') return { status: 'PAUSED', approvalId: step.approvalId, state };
      turn.results.push(step.block);
      turn.awaiting = null;
      turn.index += 1;
    }
    return null;
  }

  private async runTool(
    context: KernelContext,
    state: NativeKernelState,
    turn: PendingTurn,
    use: ToolUse,
  ): Promise<Step> {
    const result = (content: string, isError: boolean): Step => ({
      kind: 'result',
      block: { type: 'tool_result', toolUseId: use.id, content, isError },
    });
    const tool = context.tools.find((candidate) => candidate.id === use.name);
    const resumed = turn.awaiting;
    const stepId = resumed?.stepId ?? randomUUID();
    const toolCallId = resumed?.toolCallId ?? randomUUID();
    if (!resumed)
      await context.emit(
        'step.started',
        { kind: 'TOOL', title: `Tool call: ${safeLabel(use.name)}` },
        stepId,
      );
    if (!tool) {
      await context.emit(
        'step.failed',
        {
          error: { code: 'TOOL_NOT_AVAILABLE', message: 'The tool is not granted to this agent.' },
        },
        stepId,
      );
      return result(`Tool ${safeLabel(use.name)} is not available.`, true);
    }
    // The digest covers the validated input, so it equals the parameters the control plane
    // checks and binds approvals to.
    let input: unknown;
    let parseError: unknown = null;
    try {
      input = tool.parse(use.input);
    } catch (error) {
      parseError = error;
    }
    let inputDigest: string;
    try {
      inputDigest = digest(parseError ? (use.input ?? null) : (input ?? null));
    } catch {
      inputDigest = digest(null);
    }
    if (!resumed)
      await context.emit(
        'tool.requested',
        { toolCallId, toolId: tool.id, toolVersion: tool.version, inputDigest },
        stepId,
      );
    if (parseError)
      return this.toolFailed(
        context,
        stepId,
        toolCallId,
        0,
        new RuntimeFailure('TOOL_INPUT_INVALID', invalidInputMessage(parseError)),
        result,
      );
    let requestId = resumed?.requestId ?? null;
    if (!resumed) {
      const action = tool.governedAction(input);
      if (action) {
        const decision = await context.requestAction({
          correlation: { ...context.correlation, stepId, toolCallId },
          action,
          toolId: tool.id,
          toolVersion: tool.version,
          inputDigest,
          summary: tool.summarize(input).slice(0, 500),
          ...(tool.sendsParameters ? { parameters: input as Record<string, unknown> } : {}),
        });
        requestId = decision.requestId;
        if (decision.decision === 'DENIED')
          return this.toolFailed(
            context,
            stepId,
            toolCallId,
            0,
            new RuntimeFailure('ACTION_DENIED', decision.reason),
            result,
          );
        if (decision.decision === 'APPROVAL_REQUIRED') {
          turn.awaiting = {
            approvalId: decision.approvalId,
            stepId,
            toolCallId,
            requestId: decision.requestId,
          };
          return { kind: 'paused', approvalId: decision.approvalId };
        }
      }
    }
    await context.emit('tool.started', { toolCallId }, stepId);
    const started = Date.now();
    try {
      const output = await (tool as RuntimeTool<unknown>).execute(input, {
        correlation: { ...context.correlation, stepId, toolCallId },
        manifest: context.manifest,
        artifacts: context.artifacts,
        registerArtifact: (artifact) => context.emit('artifact.created', { artifact }, stepId),
        signal: context.signal,
        ...(requestId
          ? {
              governedAction: {
                requestId,
                execute: () =>
                  context.executeAction({
                    requestId,
                    correlation: { ...context.correlation, stepId, toolCallId },
                  }),
                grant: () =>
                  context.requestGrant({
                    requestId,
                    correlation: { ...context.correlation, stepId, toolCallId },
                  }),
              },
            }
          : {}),
      });
      state.artifactIds.push(...output.artifactIds);
      await context.emit(
        'tool.completed',
        {
          toolCallId,
          outputDigest: digest(output.output),
          durationMs: Date.now() - started,
          artifactIds: output.artifactIds,
        },
        stepId,
      );
      await context.emit('step.completed', { outputSummary: `${tool.id} succeeded` }, stepId);
      return result(output.output.slice(0, 50_000), false);
    } catch (error) {
      context.signal.throwIfAborted();
      const failure =
        error instanceof RuntimeFailure
          ? error
          : new RuntimeFailure('TOOL_EXECUTION_FAILED', `${tool.id} failed.`);
      return this.toolFailed(context, stepId, toolCallId, Date.now() - started, failure, result);
    }
  }

  private async toolFailed(
    context: KernelContext,
    stepId: string,
    toolCallId: string,
    durationMs: number,
    failure: RuntimeFailure,
    result: (content: string, isError: boolean) => Step,
  ): Promise<Step> {
    const error = failure.toExecutionError();
    await context.emit('tool.failed', { toolCallId, error, durationMs }, stepId);
    await context.emit('step.failed', { error }, stepId);
    return result(`${error.code}: ${error.message}`, true);
  }

  private fail(code: string, message: string): KernelOutcome {
    return { status: 'FAILED', error: new RuntimeFailure(code, message) };
  }
}

function invalidInputMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ')
      .slice(0, 1000);
  return 'The tool input is invalid.';
}

function systemPrompt(context: KernelContext): string {
  const { identity, skills, workflows, configuration } = context.manifest.payload;
  return [
    `You are ${identity.name}, a ${identity.role} employee agent in the ${identity.department} department.`,
    `You work for one employee inside their organization. Skills: ${skills.map((skill) => skill.id).join(', ') || 'none'}.`,
    `Workflows you may follow: ${workflows.join(', ') || 'none'}.`,
    'Use only the tools you are given. Some tool calls perform governed actions: the platform may',
    'deny them or pause the run until a human approves. Never claim an action happened unless its',
    'tool call succeeded. Never ask for, reveal or store secrets.',
    `Assignment configuration (JSON): ${JSON.stringify(configuration)}`,
  ].join('\n');
}

function taskPrompt(context: KernelContext): string {
  const { task } = context;
  return [
    `Objective: ${task.objective}`,
    task.workflow ? `Workflow: ${task.workflow}` : '',
    task.workItem ? `Work item: ${task.workItem.system} ${task.workItem.key}` : '',
    Object.keys(task.inputs).length ? `Inputs (JSON): ${JSON.stringify(task.inputs)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
