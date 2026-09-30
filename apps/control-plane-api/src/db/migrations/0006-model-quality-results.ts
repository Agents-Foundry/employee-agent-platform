/**
 * Model-quality results (ADR 0026): the scheduled live evaluation's history (ADR 0025),
 * imported by an operator. The results describe catalog roles, not any organization, so the
 * table has no tenant: every organization reads the same rows, and only the platform role
 * writes them. Results are never changed or deleted.
 */
export const modelQualityResultsSql = String.raw`
CREATE TABLE model_quality_results (
 run_id text NOT NULL CHECK(length(run_id) BETWEEN 1 AND 200),
 run_at text NOT NULL,
 commit_sha text CHECK(length(commit_sha) <= 64),
 provider text NOT NULL CHECK(length(provider) BETWEEN 1 AND 200),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
 judge_model text NOT NULL CHECK(length(judge_model) BETWEEN 1 AND 200),
 blueprint text NOT NULL CHECK(length(blueprint) BETWEEN 1 AND 200),
 suite text NOT NULL CHECK(length(suite) BETWEEN 1 AND 200),
 task text NOT NULL CHECK(length(task) BETWEEN 1 AND 200),
 trial integer NOT NULL CHECK(trial BETWEEN 1 AND 100),
 passed boolean NOT NULL,
 score double precision NOT NULL CHECK(score BETWEEN 0 AND 1),
 pass_threshold double precision NOT NULL CHECK(pass_threshold BETWEEN 0 AND 1),
 failed_gates text NOT NULL,
 run_status text NOT NULL CHECK(length(run_status) BETWEEN 1 AND 200),
 tokens bigint NOT NULL CHECK(tokens >= 0),
 estimated_cost_usd double precision CHECK(estimated_cost_usd >= 0),
 imported_at text NOT NULL,
 PRIMARY KEY(run_id, provider, model, judge_model, blueprint, task, trial)
);
CREATE INDEX model_quality_results_run_at ON model_quality_results(run_at);
CREATE TRIGGER model_quality_results_no_update BEFORE UPDATE ON model_quality_results
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_QUALITY_RESULT_IMMUTABLE');
CREATE TRIGGER model_quality_results_no_delete BEFORE DELETE ON model_quality_results
 FOR EACH ROW EXECUTE FUNCTION af_reject('MODEL_QUALITY_RESULT_IMMUTABLE');

GRANT SELECT ON model_quality_results TO af_tenant;
GRANT SELECT, INSERT ON model_quality_results TO af_platform;
`;
