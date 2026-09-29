// Organization model spending limits (ADR 0021). Limits are in tokens: the control plane
// knows what providers report, not what they bill.

export interface OrganizationModelBudget {
  /** Tokens (input and output) the organization's agents may use per UTC calendar month. */
  monthlyTokenLimit: number | null;
  /** Tokens one run may use. */
  runTokenLimit: number | null;
  /** Optimistic concurrency; 0 until the organization first sets a budget. */
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ModelUsageTotals {
  /** Settled usage plus unsettled reservations: what counts against a limit. */
  chargedTokens: number;
  calls: number;
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
  byAgent: (ModelUsageTotals & { agentId: string })[];
  byModel: (ModelUsageTotals & { provider: string; model: string })[];
}
