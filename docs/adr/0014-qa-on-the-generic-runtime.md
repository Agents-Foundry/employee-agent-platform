# ADR 0014: QA runs on the generic runtime

- Status: Accepted
- Date: 2026-09-26

## Context

`POST /api/qa/runs` has produced a fixed six-step plan and one approval since the pilot. The
plan never runs: nothing reads the story, checks out code, runs a browser or files defects.
Phases C to E built the parts a real QA run needs:

- the agent runtime;
- the Action Gateway with Jira;
- the execution runtime with grants.

The QA Engineer must now use them. The platform rules still apply: no role-specific branches
in the runtime, governed actions decided by the control plane, and flags that never weaken
security.

## Decision

1. **Feature flag.** With `QA_GENERIC_RUNTIME_ENABLED=true`, `POST /api/qa/runs` queues a
   generic `validate-story` run (`mode: GENERIC_RUNTIME`), but only for agents that have a
   v2 manifest whose pinned catalog bundle contains that workflow. Every other case keeps the
   legacy static plan (`mode: LEGACY_STATIC_PLAN`), which executes nothing: the flag being
   off, the built-in demo agent, and v1 agents. A target outside the agent's configured QA
   origin is refused (`TARGET_OUT_OF_SCOPE`) before anything is queued. Policy v2 checks the
   scope again for every browser run.
2. **Workflows are delivered, not hard-coded.** `run.submit` gains an optional `workflow`, the
   task's workflow definition. The control plane resolves it from the exact catalog bundle the
   manifest pins (by blueprint version and digest). A run naming a workflow the bundle does
   not grant is cancelled with `MANIFEST_INVALID` and is never submitted. The parser requires
   `workflow.id` to equal `task.workflow`. The native kernel renders any workflow as numbered
   guidance. It has no QA code, and guidance never grants anything: each step's action is
   still decided when a tool requests it.
3. **`jira.read` is a governed control-plane action.** It reads one work item in a project the
   organization's Jira connection allows. It needs the `issueTracker.read` capability and is
   allowed by default (LOW risk); organizations can tighten it. The result is bounded plain
   text (description capped at 2,000 characters). The audit log keeps only the issue key. The
   `issue-tracker` tool returns the description to the model fenced and labelled as data, not
   instructions.
4. **Conversations and threads.** A run started from a conversation uses that conversation's
   thread. A thread has at most one active run (`THREAD_HAS_ACTIVE_RUN`) and keeps its
   execution workspace across runs. The control plane mirrors approval requests, completion
   summaries, failures and cancellations into the conversation (`conversationSync: REQUIRED`).
5. **The employee app follows the run** through `GET /api/execution/v1/runs/:id`. It shows
   status, steps, pending approvals and evidence, and can cancel the run. It no longer shows
   a pre-written plan for these runs.

## Consequences

- A QA story now runs end to end under governance. The agent reads the story, checks out the
  configured repository, runs Playwright after approval, and files defects after approval.
  Every step leaves events, artifacts and audit records.
- The legacy route, its response fields and the legacy approval flow are unchanged when the
  flag is off. Clients should branch on `mode`.
- The QA Engineer requires a sandbox, so real execution still needs
  `EXECUTION_ALLOW_UNSANDBOXED=true` until a sandboxing provider exists (ADR 0013).
- A workflow is guidance to a model, not a state machine. Step order is not enforced. Enforcing
  it (for example, no defect filing before a browser run) would be a policy condition, which
  is future work.
