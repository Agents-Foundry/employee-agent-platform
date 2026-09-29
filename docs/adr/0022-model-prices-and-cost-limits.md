# ADR 0022: Per-model prices and cost limits

- Status: Accepted
- Date: 2026-09-29

## Context

ADR 0021 limits model use in tokens, counted the same across all models. A token of a large
model can cost many times one of a small model, so a token limit is a poor stand-in for the
money an organization means to cap, and administrators could not see what usage cost.

The platform does not know what an organization pays: prices vary by provider, model, region
and contract. Only the organization does.

## Decision

1. **Organizations set their own prices.** Each organization keeps a price book: for each
   provider and model, a price per million input tokens and per million output tokens.
   - Amounts are integers in millionths ("micros") of the organization's currency. Arithmetic
     is exact (BigInt), and a call's cost is rounded up to the next micro.
   - Prices are capped at 10,000 units per million tokens, and cost limits at one billion
     units.

2. **The price book is append-only.**
   - Each change adds a row that supersedes the model's previous one. A row without prices
     removes the model's price.
   - Changes use optimistic concurrency: the caller names the price it replaces
     (`expectedPriceId`, or null for none).
   - Rows are never updated or deleted (triggers). Each change records a before/after change
     event.

3. **Each call is costed at the price it was reserved under.**
   - A reservation records the model's current price and the cost of its reserved size.
   - Settlement costs the reported usage at that same price, so a price change never rewrites
     what an earlier call cost, even a call that was running when the price changed.
   - Calls to a model without a price record no cost. Reports count them separately as
     `unpricedCalls`.

4. **Cost limits sit beside token limits.** A budget gains an optional monthly and per-run
   cost limit.
   - Under the same per-organization lock as ADR 0021, each limit set allows some amount of
     output for the call's estimated input. The tightest limit, in tokens or in cost, decides.
   - What counts against a cost limit is settled cost plus the reserved cost of unsettled
     calls.
   - Fail closed: with a cost limit set, a model without a price cannot be called. The call
     is denied and audited as `model.price.unavailable`.

5. **One currency per organization, fixed once priced.** The budget holds an ISO 4217 code,
   `USD` by default. It can change only while the organization has never set a price, so
   recorded costs never mix currencies.

6. **The runtime protocol is unchanged.**
   - Denials keep the single code `MODEL_BUDGET_EXCEEDED`. The reason says which limit was
     reached, and the audit event names the scope (`MONTHLY_COST`, `RUN_COST` or `PRICE`).
   - Runtimes from ADR 0021 need no update, and deployment order does not matter.

7. **Administration.**
   - `GET` and `PUT /api/organization/model-prices`, and
     `POST /api/organization/model-prices/remove`.
   - `PUT /api/organization/model-budget` accepts `currency`, `monthlyCostLimitMicros` and
     `runCostLimitMicros`. Omitting them keeps their values, so older clients that send only
     token limits do not clear cost limits.
   - The usage report adds cost totals and the remaining monthly cost.
   - The admin console edits prices and cost limits in currency units and shows cost by agent
     and model.

## Consequences

- Cost is what the organization's prices say, not what a provider bills. Discounts, cached
  input, batch pricing and taxes are not modelled.
- Unpriced calls made before a cost limit was set count as zero cost against it.
- A denial for a missing price uses the budget code. Runtimes and employees see it as a
  budget stop; only the reason and the audit event tell the two apart.
- Changing the currency after prices exist needs a new organization-level decision; no
  migration of recorded costs is offered.
- Alerts before a limit is reached are still separate work.
