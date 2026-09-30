# ADR 0026: Model quality in the control plane

- Status: Accepted
- Date: 2026-09-30

## Context

The weekly live evaluation (ADR 0025) keeps its score history in a GitHub Actions artifact
and summarizes it in the job summary. Administrators choose each agent's provider and model
in the control plane, where none of that evidence is visible. The evaluation runs in CI, away
from any control plane, and a control plane must not trust data pushed to it without
authentication.

## Decision

1. **Results are platform data.** `model_quality_results` holds one row per trial, in the
   history record format of ADR 0025.
   - Results describe catalog roles, not an organization, so the table has no tenant column.
     Every organization reads the same rows.
   - The tenant role may only read. The platform role may read and insert.
   - Triggers stop even the schema owner from changing or deleting a result.
   - No model or grader output is stored, only scores and outcomes.

2. **An operator imports them.** `npm run db:import-quality -- <file>` imports the
   `quality-history` artifact.
   - Every line is validated before anything is written. A malformed line fails the import,
     naming only its line number.
   - The import is one transaction. Results already imported are skipped, so the growing
     history can be imported again after every run.
   - There is no API for writing results. The only path in is the database, with the
     operator's credentials.

3. **Admins read the trend.** `GET /api/catalog/v1/quality` returns every series with a run in
   the window (default 182 days, 7 to 730), optionally for one role or role version.
   - It uses the same trend calculation as the scheduled run: now shared code in
     `src/quality/quality-history.ts`. Unlike the job, it keeps series no longer scheduled,
     because the view is a record.
   - It is for admins only. Filters are validated, and the role filter's pattern characters
     are escaped.

4. **The admin console shows it.** The Model quality panel has a table per role version and
   task. Each row is one model with its grader, and shows:
   - its status, regressions first;
   - the latest pass rate and score;
   - the baseline;
   - its last eight scores, as a chart with an accessible label.

   Admins can filter by role. With no results, the panel explains how they are imported.

## Consequences

- Results reach a control plane only when an operator imports them. How fresh they are
  depends on that step, and the panel shows when results were last imported.
- The results are the same for every organization. An organization's own agents,
  configuration or data are not evaluated.
- Scores compare fairly only within a grader and role version. The panel shows both, and
  does not rank across them.
- The panel informs a choice; it does not restrict which models an admin may choose.
