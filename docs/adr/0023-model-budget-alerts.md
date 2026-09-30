# ADR 0023: Model budget alerts

- Status: Accepted
- Date: 2026-09-29

## Context

Monthly token and cost limits (ADRs 0021 and 0022) stop model calls when they are reached,
and runs fail. Until now administrators learned of it only from failed runs or by opening the
usage report. They need warning while there is still room to raise a limit or slow down.

The control plane has no email or webhook delivery. Invitations, for example, return a token
for the administrator to pass on.

## Decision

1. **Thresholds are part of the budget.** An organization chooses up to five percentages, from
   1 to 99, of its monthly limits (`alertThresholdsPercent`). The default is 80.
   - Reaching a limit always raises an alert at 100%, whatever thresholds are set.
   - Per-run limits do not alert. They stop a single run, which reports its own failure.

2. **Alerts are raised where charged usage changes:**
   - after a reservation is allowed;
   - after a settlement;
   - after an administrator changes the budget, so a lowered limit alerts at once.

   Charged usage is the same measure the limits use: settled usage plus unsettled
   reservations. A large reservation can therefore raise an alert before the call finishes,
   even if its final usage is smaller.

3. **A refusal counts as reached.** When a monthly limit refuses a call, its 100% alert is
   raised even if a little of the limit is left. The remainder was too small for the call.

4. **Each alert is raised once.**
   - Alerts are unique per organization, month, limit (`MONTHLY_TOKENS` or `MONTHLY_COST`)
     and threshold. Concurrent checks cannot duplicate one; the database keeps the first.
   - Each alert records the limit and the charged usage at that moment, and is audited as
     `model.budget.alert`.

5. **Alerts are history.**
   - An administrator may acknowledge an alert, once. The acknowledgement is recorded as a
     change event.
   - Nothing else about an alert changes, and alerts are never deleted (triggers). Both
     tables have row-level security.

6. **Administration.**
   - `GET /api/organization/model-alerts?period=YYYY-MM` and
     `POST /api/organization/model-alerts/:id/acknowledge`.
   - `PUT /api/organization/model-budget` accepts `alertThresholdsPercent`. Omitting it keeps
     the current thresholds.
   - The admin console shows the month's alerts above the usage summary.

## Consequences

- Alerts reach administrators only in the admin console and the audit log. Delivery by email
  or webhook is separate work, and would add outbound network access that needs its own
  controls.
- If a limit is raised after an alert, the alert stays: it records what happened. If usage
  then reaches the same threshold of the new limit in the same month, no second alert is
  raised.
- Existing budgets start alerting at 80% of their monthly limits once this migration runs.
