import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRICS } from '../../../packages/telemetry/src/metrics.js';
import {
  ALERTS,
  DASHBOARD,
  FORBIDDEN_LABELS,
  definitionProblems,
  type AlertDefinition,
} from '../../../packages/operations/src/definitions.js';
import {
  grafanaDashboard,
  neutralDefinitions,
  prometheusRules,
  promql,
} from '../../../packages/operations/src/render.js';
import { parseThresholds, resolveAlerts } from '../../../packages/operations/src/thresholds.js';

const root = join(import.meta.dirname, '..', '..', '..');
const panels = DASHBOARD.flatMap((section) => section.panels);

describe('operator dashboards and alerts', () => {
  it('surfaces every signal a pilot operator needs, from catalog metrics only', () => {
    expect(definitionProblems()).toEqual([]);
    const metricsOf = (ids: string[]) =>
      ids.map((id) => {
        const panel = panels.find((item) => item.id === id);
        expect(panel, id).toBeDefined();
        return JSON.stringify(panel!.query);
      });
    // Each required signal, and the metric that answers it.
    const required: Record<string, string> = {
      'runs-by-status': 'af_runs',
      'runs-failed': 'af_runs_finished_total',
      'completion-rate': 'af_runs_finished_total',
      'recovery-rate': 'af_run_recoveries_total',
      'runs-abandoned': 'af_runs_abandoned_total',
      'reconciliations-open': 'af_action_reconciliations_open',
      'approval-wait': 'af_approval_wait_ms',
      'model-latency': 'af_model_latency_ms',
      'model-tokens': 'af_model_tokens_total',
      'model-cost': 'af_model_cost_micros_total',
      'model-budget-denials': 'af_model_budget_decisions_total',
      'connector-failures': 'af_connector_errors_total',
      'secret-failures': 'af_secret_resolutions_total',
      'object-store-failures': 'af_object_store_failures_total',
      'credential-lease-failures': 'af_credential_leases_total',
      'egress-failures': 'af_egress_failures_total',
      'checkpoint-problems': 'af_checkpoint_writes_total',
      'checkpoint-read-failures': 'af_checkpoint_reads_total',
      'artifact-integrity': 'af_artifact_integrity_failures_total',
      'telemetry-dropped': 'af_telemetry_dropped_total',
    };
    const queries = metricsOf(Object.keys(required));
    Object.values(required).forEach((metric, index) => expect(queries[index]).toContain(metric));
    for (const id of [
      'reconciliation-required',
      'lease-expired',
      'secret-store-unavailable',
      'object-store-failures',
      'artifact-integrity',
      'egress-unavailable',
      'checkpoint-corrupt',
      'model-budget-denials',
      'telemetry-dropped',
    ])
      expect(ALERTS.map((alert) => alert.id)).toContain(id);
  });

  it('refuses definitions that reach outside the catalog or for identifying labels', () => {
    const bad = (query: AlertDefinition['query']): AlertDefinition => ({
      ...ALERTS[0]!,
      id: 'bad-alert',
      query,
    });
    const problems = definitionProblems(
      [],
      [
        bad({ kind: 'value', metric: 'af_prompts' as never }),
        bad({
          kind: 'increase',
          metric: 'af_runs_created_total',
          by: ['repository'],
          window: '1h',
        }),
        bad({ kind: 'value', metric: 'af_runs', where: { email: 'x' } }),
        bad({
          kind: 'quantile',
          metric: 'af_runs_created_total' as never,
          quantile: 0.9,
          window: '1h',
        }),
        bad({ kind: 'increase', metric: 'af_runs' as never, window: '1h' }),
      ],
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'Duplicate alert bad-alert',
        'alert bad-alert: unknown metric af_prompts',
        'alert bad-alert: af_runs_created_total has no label repository',
        'alert bad-alert: label repository may not be used',
        'alert bad-alert: af_runs has no label email',
        'alert bad-alert: label email may not be used',
        'alert bad-alert: quantile cannot be used on af_runs_created_total (counter)',
        'alert bad-alert: increase cannot be used on af_runs (gauge)',
      ]),
    );
    // The catalog itself labels nothing with an identity, a location or content.
    for (const [name, definition] of Object.entries(METRICS))
      for (const label of definition.labels)
        expect(FORBIDDEN_LABELS as readonly string[], `${name}.${label}`).not.toContain(label);
  });

  it('renders the same queries for Prometheus and Grafana, naming only catalog metrics', () => {
    expect(
      promql({
        kind: 'increase',
        metric: 'af_credential_leases_total',
        where: { event: { in: ['refused', 'unavailable'] }, code: { not: 'none' } },
        by: ['code'],
        window: '15m',
      }),
    ).toBe(
      'sum by (code) (increase(af_credential_leases_total{event=~"refused|unavailable",code!="none"}[15m]))',
    );
    expect(
      promql({
        kind: 'quantile',
        metric: 'af_model_latency_ms',
        quantile: 0.95,
        by: ['model'],
        window: '15m',
      }),
    ).toBe('histogram_quantile(0.95, sum by (model, le) (rate(af_model_latency_ms_bucket[15m])))');
    expect(promql({ kind: 'increase', metric: 'af_approval_wait_ms', window: '1h' })).toBe(
      'sum (increase(af_approval_wait_ms_count[1h]))',
    );
    const rendered = [
      prometheusRules(resolveAlerts()),
      JSON.stringify(grafanaDashboard()),
      JSON.stringify(neutralDefinitions(resolveAlerts())),
    ].join('\n');
    const names = new Set(
      [...rendered.matchAll(/\baf_[a-z_]+/g)].map((match) =>
        match[0].replace(/_(bucket|count|sum)$/, ''),
      ),
    );
    names.delete('af_alert');
    for (const name of names) expect(Object.keys(METRICS), name).toContain(name);
  });

  it('lets a deployment tune thresholds, hold times and severity, but never the query', () => {
    const thresholds = parseThresholds({
      version: 1,
      alerts: {
        'runs-failing': { threshold: 12, for: '10m', severity: 'critical' },
        'egress-denials-high': { enabled: false },
      },
    });
    const alerts = resolveAlerts(thresholds);
    const failing = alerts.find((alert) => alert.id === 'runs-failing')!;
    expect(failing).toMatchObject({
      threshold: 12,
      for: '10m',
      severity: 'critical',
      overridden: true,
    });
    expect(failing.query).toEqual(ALERTS.find((alert) => alert.id === 'runs-failing')!.query);
    const rules = prometheusRules(alerts);
    expect(rules).toContain('{status=\\"FAILED\\"}[1h])) > 12"');
    expect(rules).not.toContain('AfEgressDenialsHigh');
    expect(prometheusRules(resolveAlerts())).toContain('AfEgressDenialsHigh');

    for (const [raw, why] of [
      [{ version: 1, alerts: { 'runs-fail': { threshold: 1 } } }, 'unknown alert runs-fail'],
      [{ version: 1, alerts: { 'runs-failing': { query: 'up' } } }, 'unknown setting query'],
      [{ version: 1, alerts: { 'runs-failing': { threshold: -1 } } }, 'non-negative number'],
      [{ version: 1, alerts: { 'runs-failing': { threshold: '5' } } }, 'non-negative number'],
      [{ version: 1, alerts: { 'runs-failing': { for: '5 minutes' } } }, 'duration'],
      [{ version: 1, alerts: { 'runs-failing': { severity: 'page' } } }, 'severity'],
      [{ version: 1, alerts: { 'runs-failing': { enabled: 'no' } } }, 'true or false'],
      [{ version: 2, alerts: {} }, 'version must be 1'],
      [{ version: 1, alerts: {}, extra: true }, 'unknown field extra'],
    ] as const)
      expect(() => parseThresholds(raw), why).toThrow(why);
  });

  it('ships exactly what the definitions render with the recommended thresholds', () => {
    const shipped = (name: string) => readFileSync(join(root, 'operations', name), 'utf8');
    const alerts = resolveAlerts();
    expect(shipped('prometheus-rules.yaml').replace(/\r\n/g, '\n')).toBe(prometheusRules(alerts));
    expect(JSON.parse(shipped('grafana-dashboard.json'))).toEqual(grafanaDashboard());
    expect(JSON.parse(shipped('operations.json'))).toEqual(
      JSON.parse(JSON.stringify(neutralDefinitions(alerts))),
    );
    // The example a deployment copies is valid.
    expect(() =>
      parseThresholds(JSON.parse(shipped('alert-thresholds.example.json'))),
    ).not.toThrow();
  });
});
