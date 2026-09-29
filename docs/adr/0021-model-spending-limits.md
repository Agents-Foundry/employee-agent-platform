# ADR 0021: Organization model spending limits

- Status: Accepted
- Date: 2026-09-29

## Context

Agents call models with organization-managed credentials. Nothing limited how much they
used: a looping run, a misconfigured agent or simple growth could spend without bound, and an
administrator could not even see usage. The model-quality evaluations (ADR 0020) added
budgets, but only for evaluation runs, inside the test harness.

## Decision

1. **Limits live in the control plane, per organization, in tokens.**
   - `organization_model_budgets` holds an optional monthly limit (UTC calendar month) and an
     optional per-run limit.
   - Tokens are what providers report. Prices vary by provider, model and contract, so the
     platform does not claim to know cost.
   - Without a budget, calls are allowed and still recorded.

2. **Every model call is reserved first and settled after.** Two signed runtime transport
   endpoints (ADR 0011) are added:
   - `POST /runtime/v1/models/reserve` carries the provider, model, estimated input tokens and
     requested output tokens;
   - `POST /runtime/v1/models/settle` carries the provider-reported input and output tokens.

   Only the runtime holding a running run's lease may reserve. Tenancy comes from the lease,
   never from the message. Settlement is single use per reservation, and is accepted after
   the run ends, so a call that finished as its run was cancelled is still counted.

3. **Decisions are conservative and serialized.**
   - Each organization's reservations are decided under a transaction advisory lock, so
     concurrent runs cannot both take the last tokens.
   - What counts against a limit is settled usage plus the full reserved size of every
     unsettled reservation.
   - A call is granted the output that still fits under the tightest limit. Below a minimum
     of 256 output tokens, or below what it asked for if less, it is denied with
     `MODEL_BUDGET_EXCEEDED`, and the denial is audited.
   - A call's real usage may exceed its reservation, because the input is an estimate. The
     overage is recorded, and later calls see it.

4. **The runtime host meters, not the kernel.** The host binds each run's model calls to a
   meter; kernels call the same `complete` and cannot skip it (kernels are replaceable, ADR
   0006).
   - The input estimate is conservative: about three characters per token over the system
     prompt, messages and tool schemas.
   - The provider is asked for no more output than was granted.
   - A denial fails the run with `MODEL_BUDGET_EXCEEDED` without calling the provider.
   - If the limit cannot be checked, no call is made (`MODEL_BUDGET_UNAVAILABLE`, retryable).
   - A provider error response settles as zero usage. A timeout or abort may have used
     tokens, so its reservation stays counted at its reserved size.
   - A failed settlement never fails a call that already happened. The reservation keeps
     counting at its reserved size, so a lost settlement can only shrink the remaining
     budget.

5. **Usage history is immutable.**
   - A reservation row allows exactly one change, its settlement, and is never deleted
     (enforced by triggers).
   - Both tables have row-level security (ADR 0018).

6. **Administration.**
   - Password-mode organization admins read and set the limits with optimistic concurrency.
     Each change records a before/after change event.
   - Admins read a month's usage by agent and by model.
   - Routes: `GET` and `PUT /api/organization/model-budget`, and
     `GET /api/organization/model-usage?period=YYYY-MM`.
   - The admin console shows usage against the limits and edits them.

## Consequences

- A limit stops model calls, not runs already in progress between calls: a run fails at its
  next model turn.
- Because the input is estimated, a single call can overshoot a limit by at most the
  difference between its real prompt size and the estimate. The estimate errs high.
- Limits count tokens across all models alike. A cheap and an expensive model use the same
  budget; per-model limits or prices are separate work.
- Employee-held keys (`EMPLOYEE_BYOK`) are not usable by server runtimes yet. When they are,
  whether their calls count against the organization's budget must be decided.
- Every model call now adds two control-plane requests, which is small next to a model call.
