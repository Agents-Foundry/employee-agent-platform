/**
 * Cost controls for model-quality evaluations (ADR 0020). Every model call, by the evaluated
 * agent or by the grader, goes through a `BudgetedProvider` that enforces its own token budget
 * and draws from one ledger for the whole evaluation run.
 *
 * Limits are checked before each call, and each call's output is capped at what remains. The
 * input of a single call cannot be known in advance, so one call can overshoot an input limit
 * by at most its own prompt; no further call is made after that.
 */
import { RuntimeFailure } from '../../../agent-runtime/src/errors.js';
import type {
  ModelCredential,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../../agent-runtime/src/models/model-gateway.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/** Tokens spent by the whole evaluation run, against its hard limit. */
export class TokenLedger {
  private used = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('TOKEN_LEDGER_LIMIT_INVALID');
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  charge(tokens: number): void {
    this.used += tokens;
  }
}

export interface CallBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * Wraps a provider under a budget and keeps the latest conversation, so the transcript can be
 * graded afterwards. It keeps the provider's id: the manifest routes to it by that id.
 */
export class BudgetedProvider implements ModelProvider {
  readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  /** Set when a call was refused because a limit was reached. */
  exceeded: string | null = null;
  /** The latest request's messages followed by its response: the conversation so far. */
  transcript: ModelMessage[] = [];

  constructor(
    private readonly inner: ModelProvider,
    private readonly budget: CallBudget,
    private readonly ledger: TokenLedger,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  async complete(
    request: ModelRequest,
    credential: ModelCredential,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const outputLeft = Math.min(
      this.budget.maxOutputTokens - this.usage.outputTokens,
      this.ledger.remaining,
    );
    const refusal =
      this.usage.inputTokens >= this.budget.maxInputTokens
        ? 'input token budget'
        : this.ledger.remaining <= 0
          ? 'evaluation run token budget'
          : outputLeft <= 0
            ? 'output token budget'
            : null;
    if (refusal) {
      this.exceeded = refusal;
      throw new RuntimeFailure('MODEL_BUDGET_EXCEEDED', `The ${refusal} is spent.`);
    }
    const response = await this.inner.complete(
      { ...request, maxTokens: Math.min(request.maxTokens, outputLeft) },
      credential,
      signal,
    );
    this.usage.calls += 1;
    this.usage.inputTokens += response.usage.inputTokens;
    this.usage.outputTokens += response.usage.outputTokens;
    this.ledger.charge(response.usage.inputTokens + response.usage.outputTokens);
    this.transcript = [...request.messages, { role: 'assistant', content: response.content }];
    return response;
  }
}

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Estimated cost in US dollars, from operator-supplied prices; never billing data. */
export function estimateCost(usage: Omit<TokenUsage, 'calls'>, pricing?: Pricing): number | null {
  if (!pricing) return null;
  const cost =
    (usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) /
    1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}
