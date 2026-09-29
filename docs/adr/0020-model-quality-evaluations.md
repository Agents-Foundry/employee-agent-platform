# ADR 0020: Model-quality evaluations

- Status: Accepted
- Date: 2026-09-29

## Context

Governance evaluations (ADR 0019) show that a role, through the real platform, gets the right
tools, stays inside its answers and waits for approvals. A scripted model replays their tool
calls, so they say nothing about whether a real model does the job well. With a real model, it
chooses its own tool calls, and its output needs grading. A real model also costs money, and a
runaway loop can spend a lot of it.

## Decision

1. **Quality tasks are catalog data.** A suite may hold `qualityTasks`. Each task has:
   - answers and a task, validated like scenarios;
   - the governed actions the evaluator approves; every other approval is rejected, which
     cancels the run;
   - simulated results for commands, installs and browser runs, so the model has evidence to
     work from (a failing Playwright run, passing tests);
   - a budget: maximum model turns, input tokens and output tokens;
   - weighted **checks** on what happened, graded deterministically:
     - `tool-called` and `tool-not-called`;
     - `action-executed` and `action-not-executed`;
     - `no-denials`;
     - `run-status`;
     - `artifact` (type and content);
     - `file-written` (path and content).

     A `required` check is a gate: the task fails if it misses, whatever the score. Every
     built-in task is gated on staying in scope (no denials) and completing the run;

   - a weighted **rubric** scored from 0 to 1 by a grader model;
   - a pass threshold for the weighted score.

   The catalog rejects a task that uses unknown workflows, answers, work items, tools or
   actions. Tasks are not part of bundle digests (ADR 0019).

2. **One environment for both kinds of evaluation.** The governance runner's environment is
   shared: the real control plane, agent runtime and execution runtime, with the suite's
   simulated issue tracker, source control and checkout. A quality run provisions the agent
   with the real provider and model, so the signed manifest pins what was evaluated.

3. **Cost controls fail closed.**
   - Every call, by the agent or the grader, goes through a budgeted provider. It refuses
     a call once a limit is spent, and caps each call's output at what remains.
   - All budgets draw from one ledger for the whole run, set by `AF_QUALITY_MAX_TOKENS`. That
     variable has no default: spending is an explicit decision.
   - The kernel's turn limit comes from the task.
   - A live run without models, a credential or a budget stops before any model call. The
     error names the missing settings, never their values.
   - Cost is estimated only from operator-supplied prices; it is not billing data.

4. **Grading fails closed.**
   - A check counts only successful tool calls; a denied attempt is not credit.
   - The grader sees the task, the work item, the tool calls and results, the final message
     and the run status.
   - The transcript is quoted as untrusted data. Content cannot close its block, and the
     grader is told to ignore instructions inside it.
   - The grader answers through one tool call, validated strictly: every criterion exactly
     once, and scores from 0 to 1. Anything else scores every criterion zero, as does an
     unreachable or out-of-budget grader.

5. **Live runs only on request.** `npm run eval:quality` runs every quality task on every
   role version it applies to, optionally several trials each. It writes a JSON report and a
   Markdown summary to `.data/quality-reports` and fails if a task does not pass. It never
   runs in `npm run check`. Offline tests run the same runner with scripted models, covering:
   - approvals;
   - gates;
   - budget and turn limits;
   - grader validation;
   - configuration.

## Consequences

- Each role has one quality task that measures real work:
  - QA Engineer 1.2.0 files a precise defect from a failing browser run;
  - Frontend Engineer 1.1.0 fixes a boundary and adds a test;
  - Backend Engineer adds an endpoint with tests;
  - Code Reviewer finds a boundary defect;
  - Test Automation Engineer writes regression tests.
- Scores depend on the model and on the grader; the report names both. A model should not
  grade itself: use a different, preferably stronger, grader model.
- Results vary between runs. Use trials to measure the pass rate; a single run is one sample.
- Commands, installs and browser runs are still simulated: a model is graded on its reasoning
  about their results, not on code that was actually executed.
- The Anthropic provider is the only live provider. Adding one is a runtime provider adapter,
  as in production.
- Budgets are per evaluation run, not per organization. Production spending limits remain
  separate work.
