// Organization model spending limits (ADR 0021) and per-model prices (ADR 0022). Token counts
// are what providers report. Money is in integer millionths ("micros") of the organization's
// currency, from prices the organization sets: the platform does not know what it is billed.

export interface OrganizationModelBudget {
  /** Tokens (input and output) the organization's agents may use per UTC calendar month. */
  monthlyTokenLimit: number | null;
  /** Tokens one run may use. */
  runTokenLimit: number | null;
  /** ISO 4217 code of every price and cost limit. Fixed once the first price is set. */
  currency: string;
  /** Cost the organization's agents may incur per UTC calendar month, in micros. */
  monthlyCostLimitMicros: number | null;
  /** Cost one run may incur, in micros. */
  runCostLimitMicros: number | null;
  /** Optimistic concurrency; 0 until the organization first sets a budget. */
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** `PUT /api/organization/model-budget`. Omitted currency and cost fields stay as they are. */
export interface OrganizationModelBudgetInput {
  monthlyTokenLimit: number | null;
  runTokenLimit: number | null;
  currency?: string;
  monthlyCostLimitMicros?: number | null;
  runCostLimitMicros?: number | null;
  version: number;
}

/** A model's current price, per million tokens, in micros of the organization's currency. */
export interface ModelPrice {
  /** Changes with every price change; pass it back as `expectedPriceId`. */
  priceId: string;
  provider: string;
  model: string;
  currency: string;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  setBy: string;
  setAt: string;
}

export interface ModelPriceBook {
  currency: string;
  prices: ModelPrice[];
}

/**
 * `PUT /api/organization/model-prices`. `expectedPriceId` is the model's current price id, or
 * null when it has none; a stale value is a conflict.
 */
export interface ModelPriceInput {
  provider: string;
  model: string;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  expectedPriceId: string | null;
}

/** `POST /api/organization/model-prices/remove`. */
export interface ModelPriceRemoval {
  provider: string;
  model: string;
  expectedPriceId: string;
}

export interface ModelUsageTotals {
  /** Settled usage plus unsettled reservations: what counts against a limit. */
  chargedTokens: number;
  /** The same, in micros, for calls made at a price. */
  chargedCostMicros: number;
  calls: number;
  /** Calls made while their model had no price: their cost is unknown and not included. */
  unpricedCalls: number;
}

export interface ModelUsageReport extends ModelUsageTotals {
  /** UTC calendar month, `YYYY-MM`. */
  period: string;
  budget: OrganizationModelBudget;
  /** Provider-reported usage of settled calls. */
  inputTokens: number;
  outputTokens: number;
  /** Calls still reserved: their reserved size counts until they settle. */
  unsettledReservedTokens: number;
  /** Monthly tokens left, or null without a monthly limit. */
  remainingTokens: number | null;
  /** Monthly cost left in micros, or null without a monthly cost limit. */
  remainingCostMicros: number | null;
  byAgent: (ModelUsageTotals & { agentId: string })[];
  byModel: (ModelUsageTotals & { provider: string; model: string })[];
}
