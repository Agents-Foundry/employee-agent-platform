import { RuntimeFailure } from '../errors.js';
import type {
  ModelContent,
  ModelCredential,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from './model-gateway.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Anthropic Messages API adapter over plain HTTPS (no SDK dependency). */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';

  constructor(
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(
    request: ModelRequest,
    credential: ModelCredential,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.fetchImpl(new URL('/v1/messages', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': credential.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content.map(toAnthropic),
        })),
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok)
      // The body may echo request details; only the status is reported.
      throw new RuntimeFailure(
        'MODEL_REQUEST_FAILED',
        `The model provider returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    const body = (await response.json()) as {
      content?: AnthropicBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content: ModelContent[] = [];
    for (const block of body.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string')
        content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use' && block.id && block.name)
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
    return {
      content,
      stopReason: body.stop_reason ?? 'unknown',
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
    };
  }
}

function toAnthropic(block: ModelContent): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}
