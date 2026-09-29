# ADR 0019: Governance evaluation suites for catalog roles

- Status: Accepted
- Date: 2026-09-29

## Context

Roles are catalog data (ADR 0009), and every blueprint named an evaluation suite, but no
suite existed and nothing ran one. Adding a role was only checked for structural consistency.
Nothing showed that the role, once provisioned, gets the right tools and cannot act outside
its answers, and that its approvals actually gate its external writes. More roles would make
that gap wider.

## Decision

1. **Suites are catalog data.** An `EvaluationSuite` belongs to one role (blueprint id) and
   holds:
   - a **world**: issue-tracker items and projects, allowed repositories, and the files a
     checkout produces;
   - deterministic **scenarios**. Each scenario has answers to the role's questions, a task
     and workflow, and scripted tool calls. Each call expects one of three results:
     - `SUCCEEDED`;
     - `FAILED` with an error code;
     - `NOT_AVAILABLE`.

     A call may also expect to pause for a named governed action, and says whether the
     evaluator approves or rejects it. A scenario also names the tools the role must be
     offered, the final run status and the control-plane actions that must have executed.
     A scenario may be limited to some versions of the role.

2. **Validation fails the catalog** if any of these is true:
   - a role version names a missing suite, or another role's suite;
   - a suite is unused;
   - a scenario uses a workflow its version does not have;
   - a scenario answers unknown questions or omits required ones;
   - a scenario calls an unknown tool;
   - a scenario expects an unknown action.

3. **Suites are not part of bundle digests.** Adding or improving evaluations never changes a
   released role version. The digests of the released versions were verified unchanged.

4. **A generic runner** (`apps/control-plane-api/test/evaluations/runner.ts`) knows no role.
   For each scenario it:
   - provisions the agent with the scenario's answers;
   - creates the connections that those answers select;
   - replays the tool calls with a scripted model through the real control plane, agent
     runtime and execution runtime;
   - decides approvals as the scenario says;
   - reports every mismatch.

   Checkouts produce the world's files. Commands, installs and browser runs are recorded
   rather than executed; the execution runtime's own tests run those for real.
   `npm run test:evals` runs every scenario on every role version it applies to, and
   `npm run check` includes them.

5. **Three new roles, as data only:**
   - Backend Engineer 1.0.0;
   - Code Reviewer 1.0.0, least privilege: no editing or source-control tools, no writes;
   - Test Automation Engineer 1.0.0.

   Each ships with a suite; the existing QA and Frontend Engineer suites now exist too.

## Consequences

- A new role cannot ship without a suite that shows, through the real platform:
  - which tools it gets;
  - that its answers bound its scope;
  - that its external writes wait for approval;
  - that rejecting an approval cancels the run.

  The role-agnostic guard now takes role, workflow and suite names from the catalog.

- These are **governance evaluations**. They do not measure how well a model plans, writes
  code or finds defects. Model-quality evaluation needs real models, graded outputs and cost
  controls, and remains separate work.
- Suites live with the catalog in this repository. Role packages published elsewhere would
  ship their suites alongside, validated by the same schema.
- Connectors the runner can simulate are Jira and GitHub. A role that needs another provider
  needs the runner extended first, as the platform itself would.
