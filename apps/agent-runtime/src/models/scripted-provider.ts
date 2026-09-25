import type {
  ModelCredential,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from './model-gateway.js';

export type ModelScript = (request: ModelRequest, turn: number) => ModelResponse;

/**
 * Deterministic provider for tests and offline demos. It does not reason: it replays a script.
 * `main.ts` registers it only when `AGENT_RUNTIME_ENABLE_SCRIPTED_MODEL=true`.
 */
export class ScriptedProvider implements ModelProvider {
  private readonly turns = new Map<string, number>();

  constructor(
    readonly id: string,
    private readonly script: ModelScript,
  ) {}

  async complete(
    request: ModelRequest,
    _credential: ModelCredential,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    signal.throwIfAborted();
    // Turns are counted per conversation so concurrent runs replay independently.
    const key = JSON.stringify(request.messages[0] ?? null);
    const turn = (this.turns.get(key) ?? 0) + 1;
    this.turns.set(key, turn);
    return this.script(request, turn);
  }

  /** Writes one report artifact, then finishes: exercises the full loop without a real model. */
  static demo(id = 'scripted'): ScriptedProvider {
    return new ScriptedProvider(id, (request) => {
      const answered = request.messages.some((message) =>
        message.content.some((block) => block.type === 'tool_result'),
      );
      const usage = { inputTokens: 0, outputTokens: 0 };
      if (answered || !request.tools.some((tool) => tool.name === 'artifact'))
        return {
          content: [{ type: 'text', text: 'Scripted run finished. No model reasoning was used.' }],
          stopReason: 'end_turn',
          usage,
        };
      return {
        content: [
          { type: 'text', text: 'Recording the task as a report (scripted demo model).' },
          {
            type: 'tool_use',
            id: 'toolu_scripted_1',
            name: 'artifact',
            input: {
              name: 'scripted-report.md',
              type: 'report',
              mediaType: 'text/markdown',
              content: `# Scripted report\n\n${request.messages[0]?.content
                .map((block) => (block.type === 'text' ? block.text : ''))
                .join('\n')}`,
            },
          },
        ],
        stopReason: 'tool_use',
        usage,
      };
    });
  }
}
