# ADR 0025: Scheduled model-quality runs and score history

- Status: Accepted
- Date: 2026-09-30

## Context

Model-quality evaluations (ADR 0020) run only when someone starts them. Each run leaves a
report, and nothing compares it with the runs before it. Models change behind the same name,
catalog roles change, and grader models change. Without a regular run and a history, a drop
in quality is found by chance, and one run's score can't be told from noise.

## Decision

1. **A weekly scheduled run.** The **Model quality** GitHub Actions workflow runs the live
   evaluation every Monday at 06:00 UTC, and on demand with a chosen number of trials (default
   3).
   - It never runs on pull requests, so the model credential is never exposed to proposed
     code.
   - It is skipped until the repository sets `AF_QUALITY_MODEL`.
   - It reads the model, grader, token budget and optional prices from repository variables,
     and the credential from a repository secret.
   - The budget still has no default (ADR 0020).
   - Runs never overlap.

2. **A history of scores, not of output.** Each trial adds one JSON Lines record:
   - run id, time and commit;
   - provider, model and grader model;
   - role version, suite and task;
   - pass, score, threshold and failed gates;
   - run status, tokens and estimated cost.

   Nothing the model or grader wrote is kept. Report files now carry the run id, time, commit
   and grader model; a report without them is refused.

3. **The history travels as an artifact.** Each run downloads `quality-history` from the most
   recent completed run that kept one, adds its records, and uploads the result.
   - Artifacts are kept for 90 days, so the history survives as long as a run completes at
     least once in 90 days.
   - A run already in the history is not added twice.
   - A malformed line fails the update, naming only its line number, instead of being
     dropped.
   - The run's full reports are kept separately for 30 days.

4. **Series and regressions.**
   - A series is a model, its grader, a role version and a task. A new grader or role version
     starts a new series, rather than looking like a change in the model.
   - The latest run of each series still in the schedule is compared with its previous three
     runs, pooled.
   - It **regressed** if its pass rate fell by at least 34 points (one trial in three) or its
     mean score by at least 0.1. It **improved** on the same margins upward, and is otherwise
     **steady**. A first run is **new**.
   - The job summary shows a table, regressions first, with each series' last eight scores.

5. **What fails the workflow.** A regression, a history that can't be updated, or a run that
   wrote no report fails the workflow. Tasks that fail without regressing only warn, so a known
   weak spot does not fail every week. It still shows in the table and the reports.

6. **Local use.** `npm run eval:quality:trend -- --history <file> [--reports <dir>]
[--summary <file>] [--fail-on-regression]` does the same outside CI.

## Consequences

- Each scheduled run spends up to `AF_QUALITY_MAX_TOKENS`. The repository owner decides that
  budget, and whether to enable the schedule at all.
- The history lives in workflow artifacts, not in the repository or the control plane. If no
  run completes for 90 days, it starts again.
- Three trials per task make a regression of one failed trial in three visible, but results
  still vary. A flagged series should be rerun before a model or role change is blamed.
- Scores are only comparable within a series. Across models they are comparable only when
  the grader and the role version are the same.
- The workflow itself can be exercised only on GitHub. Locally, the history and trend code
  is tested offline with built reports, and the command is run directly.
