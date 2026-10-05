import {
  METRICS,
  type CounterName,
  type GaugeName,
  type HistogramName,
  type MetricName,
} from '../../telemetry/src/metrics.js';

/**
 * Operator dashboards and alerts (ADR 0039), written once against the platform's own metric
 * catalog and rendered for whichever monitoring system a deployment uses. Queries name
 * catalog metrics and catalog labels only, so a definition cannot reach for content the
 * telemetry never holds: no prompt, response, file name, URL, repository, email or secret.
 */

/** `15m`, `1h`, `6h`: a window or a hold time. */
export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;

/** Exact value, any value but, or one of several. Values are catalog label values. */
export type Match =
  string | { not: string } | { in: readonly string[] } | { notIn: readonly string[] };
export type Selector = Readonly<Record<string, Match>>;

export type Query =
  /** The current value of a gauge, summed. */
  | { kind: 'value'; metric: GaugeName; where?: Selector; by?: readonly string[] }
  /** How much a counter (or a histogram's count) grew over the window, summed. */
  | {
      kind: 'increase';
      metric: CounterName | HistogramName;
      where?: Selector;
      by?: readonly string[];
      window: Duration;
    }
  /** A quantile of a histogram over the window. */
  | {
      kind: 'quantile';
      metric: HistogramName;
      quantile: number;
      where?: Selector;
      by?: readonly string[];
      window: Duration;
    }
  /** One query divided by another; undefined (no data) when the denominator is zero. */
  | { kind: 'ratio'; numerator: Query; denominator: Query };

export interface Panel {
  id: string;
  title: string;
  /** What the operator should read from it. */
  description: string;
  unit: 'count' | 'ratio' | 'ms' | 'tokens' | 'micros';
  query: Query;
}

export interface DashboardSection {
  id: string;
  title: string;
  panels: Panel[];
}

export type Severity = 'critical' | 'warning' | 'info';

export interface AlertDefinition {
  id: string;
  title: string;
  /** What is wrong and what to do first; the runbook section has the rest. */
  description: string;
  severity: Severity;
  query: Query;
  comparison: '>' | '<';
  /** The recommended threshold. A deployment may change it, never the query. */
  threshold: number;
  /** How long the condition must hold before the alert fires. */
  for: Duration;
  /** Section of docs/pilot-runbook.md to follow. */
  runbook: string;
}

const RUN_FINISHED = 'af_runs_finished_total';

export const DASHBOARD: readonly DashboardSection[] = [
  {
    id: 'runs',
    title: 'Runs',
    panels: [
      {
        id: 'runs-by-status',
        title: 'Running, queued and waiting runs',
        description: 'Runs right now, by status. Waiting means waiting for an approval.',
        unit: 'count',
        query: { kind: 'value', metric: 'af_runs', by: ['status'] },
      },
      {
        id: 'runs-failed',
        title: 'Failed runs',
        description: 'Runs that failed in the last hour, by reason code.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: RUN_FINISHED,
          where: { status: 'FAILED' },
          by: ['reason'],
          window: '1h',
        },
      },
      {
        id: 'completion-rate',
        title: 'Completion rate',
        description: 'Share of runs that ended in the last six hours and completed.',
        unit: 'ratio',
        query: {
          kind: 'ratio',
          numerator: {
            kind: 'increase',
            metric: RUN_FINISHED,
            where: { status: 'COMPLETED' },
            window: '6h',
          },
          denominator: { kind: 'increase', metric: RUN_FINISHED, window: '6h' },
        },
      },
      {
        id: 'queue-wait',
        title: 'Queue wait (p95)',
        description: 'How long runs waited for a runtime.',
        unit: 'ms',
        query: { kind: 'quantile', metric: 'af_run_queue_wait_ms', quantile: 0.95, window: '1h' },
      },
    ],
  },
  {
    id: 'recovery',
    title: 'Recovery',
    panels: [
      {
        id: 'leases-expired-now',
        title: 'Expired leases',
        description: 'Runs whose runtime stopped signalling and that nothing has picked up yet.',
        unit: 'count',
        query: { kind: 'value', metric: 'af_runtime_leases', where: { state: 'expired' } },
      },
      {
        id: 'recovery-rate',
        title: 'Recovery rate',
        description: 'Runs handed to another runtime, per lease found expired, in six hours.',
        unit: 'ratio',
        query: {
          kind: 'ratio',
          numerator: { kind: 'increase', metric: 'af_run_recoveries_total', window: '6h' },
          denominator: {
            kind: 'increase',
            metric: 'af_runtime_leases_expired_total',
            window: '6h',
          },
        },
      },
      {
        id: 'runs-abandoned',
        title: 'Abandoned runs',
        description: 'Runs cancelled because nothing could continue them, by code.',
        unit: 'count',
        query: { kind: 'increase', metric: 'af_runs_abandoned_total', by: ['code'], window: '1h' },
      },
      {
        id: 'checkpoint-problems',
        title: 'Checkpoint conflicts and corruption',
        description:
          'Saves refused (two runtimes on one run, a stale version) and loads that failed verification.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_checkpoint_writes_total',
          where: { result: { not: 'saved' } },
          by: ['result'],
          window: '1h',
        },
      },
      {
        id: 'checkpoint-read-failures',
        title: 'Checkpoint loads refused',
        description: 'Loads that were neither a verified checkpoint nor an absent one.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_checkpoint_reads_total',
          where: { result: { notIn: ['loaded', 'missing'] } },
          by: ['result'],
          window: '1h',
        },
      },
    ],
  },
  {
    id: 'governance',
    title: 'Governance',
    panels: [
      {
        id: 'reconciliations-open',
        title: 'Writes to reconcile',
        description: 'Writes with an unknown outcome that an administrator has not resolved.',
        unit: 'count',
        query: { kind: 'value', metric: 'af_action_reconciliations_open', by: ['reason'] },
      },
      {
        id: 'approval-wait',
        title: 'Approval wait (p95)',
        description: 'How long approvals waited for a decision.',
        unit: 'ms',
        query: { kind: 'quantile', metric: 'af_approval_wait_ms', quantile: 0.95, window: '6h' },
      },
      {
        id: 'action-denials',
        title: 'Action Gateway denials',
        description: 'Governed actions denied, by action.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_action_decisions_total',
          where: { decision: 'denied' },
          by: ['action'],
          window: '1h',
        },
      },
    ],
  },
  {
    id: 'models',
    title: 'Models',
    panels: [
      {
        id: 'model-latency',
        title: 'Model latency (p95)',
        description: 'Model call latency by provider and model.',
        unit: 'ms',
        query: {
          kind: 'quantile',
          metric: 'af_model_latency_ms',
          quantile: 0.95,
          by: ['provider', 'model'],
          window: '15m',
        },
      },
      {
        id: 'model-tokens',
        title: 'Tokens',
        description: 'Tokens settled in the last hour, input and output.',
        unit: 'tokens',
        query: {
          kind: 'increase',
          metric: 'af_model_tokens_total',
          by: ['provider', 'model', 'direction'],
          window: '1h',
        },
      },
      {
        id: 'model-cost',
        title: 'Cost',
        description: 'Settled cost in the last hour, in millionths of the currency.',
        unit: 'micros',
        query: {
          kind: 'increase',
          metric: 'af_model_cost_micros_total',
          by: ['currency'],
          window: '1h',
        },
      },
      {
        id: 'model-budget-denials',
        title: 'Budget denials',
        description: 'Model calls refused by a spending limit, by limit.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_model_budget_decisions_total',
          where: { decision: 'denied' },
          by: ['code'],
          window: '1h',
        },
      },
      {
        id: 'model-failures',
        title: 'Failed model calls',
        description: 'Model calls that did not succeed, by provider and code.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_model_calls_total',
          where: { result: { not: 'succeeded' } },
          by: ['provider', 'result'],
          window: '1h',
        },
      },
    ],
  },
  {
    id: 'dependencies',
    title: 'Dependencies',
    panels: [
      {
        id: 'connector-failures',
        title: 'Connector failures',
        description: 'Connector calls that failed, by provider and code.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_connector_errors_total',
          by: ['provider', 'code'],
          window: '1h',
        },
      },
      {
        id: 'secret-failures',
        title: 'Secret and Vault failures',
        description: 'Secret resolutions that failed, by provider and result.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_secret_resolutions_total',
          where: { result: { not: 'resolved' } },
          by: ['provider', 'result'],
          window: '1h',
        },
      },
      {
        id: 'object-store-failures',
        title: 'Object store failures',
        description: 'Artifact store operations that failed, by operation.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_object_store_failures_total',
          by: ['operation'],
          window: '1h',
        },
      },
      {
        id: 'credential-lease-failures',
        title: 'Credential lease failures',
        description: 'Repository credential leases refused or unavailable, by code.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_credential_leases_total',
          where: { event: { in: ['refused', 'unavailable'] } },
          by: ['event', 'code'],
          window: '1h',
        },
      },
      {
        id: 'database-retries',
        title: 'Database retries',
        description: 'Transactions run again, by reason.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_database_retries_total',
          by: ['reason'],
          window: '1h',
        },
      },
    ],
  },
  {
    id: 'execution',
    title: 'Execution and evidence',
    panels: [
      {
        id: 'egress-failures',
        title: 'Sandbox and egress failures',
        description: 'Operations refused because egress control was unavailable, by code.',
        unit: 'count',
        query: { kind: 'increase', metric: 'af_egress_failures_total', by: ['code'], window: '1h' },
      },
      {
        id: 'egress-denials',
        title: 'Egress denials',
        description: 'Connections from sandboxes the egress proxy refused.',
        unit: 'count',
        query: { kind: 'increase', metric: 'af_egress_denials_total', window: '1h' },
      },
      {
        id: 'sandbox-startup',
        title: 'Sandbox start-up (p95)',
        description: 'Time to prepare a sandbox before its operation started.',
        unit: 'ms',
        query: { kind: 'quantile', metric: 'af_sandbox_startup_ms', quantile: 0.95, window: '1h' },
      },
      {
        id: 'execution-failures',
        title: 'Failed operations',
        description: 'Execution-runtime operations that did not succeed, by kind and code.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_execution_operations_total',
          where: { status: { not: 'SUCCEEDED' } },
          by: ['kind', 'code'],
          window: '1h',
        },
      },
      {
        id: 'artifact-integrity',
        title: 'Artifact integrity failures',
        description: 'Artifacts whose stored bytes did not match their record, by code.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_artifact_integrity_failures_total',
          by: ['code'],
          window: '1h',
        },
      },
      {
        id: 'telemetry-dropped',
        title: 'Telemetry dropped',
        description: 'Telemetry refused or not exported, by kind.',
        unit: 'count',
        query: {
          kind: 'increase',
          metric: 'af_telemetry_dropped_total',
          by: ['kind'],
          window: '1h',
        },
      },
    ],
  },
];

export const ALERTS: readonly AlertDefinition[] = [
  {
    id: 'runs-failing',
    title: 'Runs are failing',
    description: 'More runs failed in the last hour than expected. The reason label says why.',
    severity: 'warning',
    query: { kind: 'increase', metric: RUN_FINISHED, where: { status: 'FAILED' }, window: '1h' },
    comparison: '>',
    threshold: 5,
    for: '5m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'completion-rate-low',
    title: 'Completion rate is low',
    description: 'Fewer than the expected share of runs completed in six hours.',
    severity: 'warning',
    query: DASHBOARD[0]!.panels[2]!.query,
    comparison: '<',
    threshold: 0.8,
    for: '30m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'queue-backlog',
    title: 'Runs are queuing',
    description: 'Runs are waiting for a runtime. Check that agent runtimes are running.',
    severity: 'warning',
    query: { kind: 'value', metric: 'af_runs', where: { status: 'QUEUED' } },
    comparison: '>',
    threshold: 20,
    for: '15m',
    runbook: 'starting-and-stopping-runtimes',
  },
  {
    id: 'lease-expired',
    title: 'A runtime is gone and its runs wait',
    description: 'Run leases expired and nothing picked the runs up.',
    severity: 'critical',
    query: { kind: 'value', metric: 'af_runtime_leases', where: { state: 'expired' } },
    comparison: '>',
    threshold: 0,
    for: '15m',
    runbook: 'recovering-a-stuck-run',
  },
  {
    id: 'recovery-rate-low',
    title: 'Expired runs are not being recovered',
    description: 'Fewer runs were handed to another runtime than leases expired.',
    severity: 'warning',
    query: DASHBOARD[1]!.panels[1]!.query,
    comparison: '<',
    threshold: 0.9,
    for: '30m',
    runbook: 'recovering-a-stuck-run',
  },
  {
    id: 'runs-abandoned',
    title: 'Runs were abandoned',
    description: 'Runs were cancelled because nothing could continue them.',
    severity: 'warning',
    query: { kind: 'increase', metric: 'af_runs_abandoned_total', window: '1h' },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'recovering-a-stuck-run',
  },
  {
    id: 'reconciliation-required',
    title: 'A write needs reconciling',
    description:
      'A governed write has an unknown outcome. An administrator must check the external system and resolve it.',
    severity: 'critical',
    query: { kind: 'value', metric: 'af_action_reconciliations_open' },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'handling-writes-to-reconcile',
  },
  {
    id: 'approval-wait-high',
    title: 'Approvals are waiting long',
    description: 'Approvals take longer than expected; runs are paused meanwhile.',
    severity: 'info',
    query: { kind: 'quantile', metric: 'af_approval_wait_ms', quantile: 0.95, window: '6h' },
    comparison: '>',
    threshold: 1_800_000,
    for: '30m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'model-latency-high',
    title: 'Model calls are slow',
    description: 'The model provider is slow to answer.',
    severity: 'warning',
    query: { kind: 'quantile', metric: 'af_model_latency_ms', quantile: 0.95, window: '15m' },
    comparison: '>',
    threshold: 60_000,
    for: '15m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'model-failures',
    title: 'Model calls are failing',
    description: 'Model calls did not succeed. Check the provider and the model credential.',
    severity: 'warning',
    query: {
      kind: 'increase',
      metric: 'af_model_calls_total',
      where: { result: { not: 'succeeded' } },
      window: '15m',
    },
    comparison: '>',
    threshold: 5,
    for: '5m',
    runbook: 'rotating-credentials',
  },
  {
    id: 'model-budget-denials',
    title: 'A model spending limit is being hit',
    description: 'Model calls were refused by a spending limit; those runs failed.',
    severity: 'warning',
    query: {
      kind: 'increase',
      metric: 'af_model_budget_decisions_total',
      where: { decision: 'denied' },
      window: '1h',
    },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'model-cost-burn',
    title: 'Model spending is high',
    description: 'More was spent on models in the last hour than expected (in micros).',
    severity: 'info',
    query: { kind: 'increase', metric: 'af_model_cost_micros_total', window: '1h' },
    comparison: '>',
    threshold: 50_000_000,
    for: '0m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'connector-failures',
    title: 'Connector calls are failing',
    description: 'Calls to Jira or GitHub failed. Check the connection and its credential.',
    severity: 'warning',
    query: { kind: 'increase', metric: 'af_connector_errors_total', window: '15m' },
    comparison: '>',
    threshold: 3,
    for: '5m',
    runbook: 'rotating-credentials',
  },
  {
    id: 'secret-store-unavailable',
    title: 'The secret store is unreachable',
    description: 'Vault did not answer. Actions and model calls that need a secret are refused.',
    severity: 'critical',
    query: {
      kind: 'increase',
      metric: 'af_secret_resolutions_total',
      where: { result: 'provider_unavailable' },
      window: '10m',
    },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'responding-to-vault-failures',
  },
  {
    id: 'secret-missing',
    title: 'A secret is missing',
    description: 'A secret reference names nothing in the secret store.',
    severity: 'warning',
    query: {
      kind: 'increase',
      metric: 'af_secret_resolutions_total',
      where: { result: { in: ['not_found', 'invalid_reference'] } },
      window: '1h',
    },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'responding-to-vault-failures',
  },
  {
    id: 'object-store-failures',
    title: 'The artifact store is failing',
    description: 'Uploads or downloads of evidence are failing.',
    severity: 'critical',
    query: { kind: 'increase', metric: 'af_object_store_failures_total', window: '10m' },
    comparison: '>',
    threshold: 0,
    for: '5m',
    runbook: 'responding-to-artifact-failures',
  },
  {
    id: 'artifact-integrity',
    title: 'Stored evidence does not match its record',
    description: 'An artifact’s bytes did not match their hash. Treat as an incident.',
    severity: 'critical',
    query: { kind: 'increase', metric: 'af_artifact_integrity_failures_total', window: '1h' },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'responding-to-artifact-failures',
  },
  {
    id: 'credential-lease-failures',
    title: 'Repository credentials are refused',
    description: 'Credential leases for private checkouts are refused or unavailable.',
    severity: 'warning',
    query: {
      kind: 'increase',
      metric: 'af_credential_leases_total',
      where: { event: { in: ['refused', 'unavailable'] } },
      window: '15m',
    },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'rotating-credentials',
  },
  {
    id: 'egress-unavailable',
    title: 'Egress control is unavailable',
    description: 'Sandboxes are refused because the egress proxy could not start.',
    severity: 'critical',
    query: { kind: 'increase', metric: 'af_egress_failures_total', window: '15m' },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'starting-and-stopping-runtimes',
  },
  {
    id: 'egress-denials-high',
    title: 'Sandboxes reach for hosts they may not',
    description: 'Many connections from sandboxes were refused. Check the allowed hosts.',
    severity: 'info',
    query: { kind: 'increase', metric: 'af_egress_denials_total', window: '1h' },
    comparison: '>',
    threshold: 50,
    for: '0m',
    runbook: 'reading-the-dashboards',
  },
  {
    id: 'sandbox-startup-slow',
    title: 'Sandboxes start slowly',
    description: 'Preparing a sandbox takes longer than expected. Check the images and the host.',
    severity: 'warning',
    query: { kind: 'quantile', metric: 'af_sandbox_startup_ms', quantile: 0.95, window: '30m' },
    comparison: '>',
    threshold: 60_000,
    for: '15m',
    runbook: 'starting-and-stopping-runtimes',
  },
  {
    id: 'checkpoint-conflicts',
    title: 'Checkpoint saves are refused',
    description: 'Two runtimes on one run, or a stale checkpoint version.',
    severity: 'warning',
    query: {
      kind: 'increase',
      metric: 'af_checkpoint_writes_total',
      where: { result: { not: 'saved' } },
      window: '15m',
    },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'recovering-a-stuck-run',
  },
  {
    id: 'checkpoint-corrupt',
    title: 'A checkpoint failed verification',
    description: 'A stored checkpoint was altered or unreadable; its run fails closed.',
    severity: 'critical',
    query: {
      kind: 'increase',
      metric: 'af_checkpoint_reads_total',
      where: { result: { notIn: ['loaded', 'missing'] } },
      window: '15m',
    },
    comparison: '>',
    threshold: 0,
    for: '0m',
    runbook: 'responding-to-database-failures',
  },
  {
    id: 'database-connections',
    title: 'The database is dropping connections',
    description: 'Transactions are being run again after lost connections.',
    severity: 'warning',
    query: {
      kind: 'increase',
      metric: 'af_database_retries_total',
      where: { reason: 'connection' },
      window: '10m',
    },
    comparison: '>',
    threshold: 10,
    for: '5m',
    runbook: 'responding-to-database-failures',
  },
  {
    id: 'telemetry-dropped',
    title: 'Telemetry is being lost',
    description: 'The collector is unreachable, or a caller tried to send content.',
    severity: 'warning',
    query: { kind: 'increase', metric: 'af_telemetry_dropped_total', window: '15m' },
    comparison: '>',
    threshold: 0,
    for: '10m',
    runbook: 'reading-the-dashboards',
  },
];

/**
 * Label names a monitoring query may never use, whatever the catalog says: they would carry
 * identities, locations or content. The catalog defines none of them; this keeps it so.
 */
export const FORBIDDEN_LABELS = [
  'run',
  'run_id',
  'thread',
  'thread_id',
  'employee',
  'employee_id',
  'user',
  'email',
  'organization',
  'organization_id',
  'url',
  'host',
  'repository',
  'repo',
  'file',
  'filename',
  'path',
  'prompt',
  'response',
  'message',
  'content',
  'secret',
  'token',
  'key',
] as const;

/** The metrics and label names a query uses. */
export function referenced(query: Query): { metric: MetricName; labels: string[] }[] {
  if (query.kind === 'ratio')
    return [...referenced(query.numerator), ...referenced(query.denominator)];
  return [
    {
      metric: query.metric,
      labels: [...Object.keys(query.where ?? {}), ...(query.by ?? [])],
    },
  ];
}

/** Problems with the definitions: unknown metrics, labels outside the catalog, misuse. */
export function definitionProblems(
  dashboard: readonly DashboardSection[] = DASHBOARD,
  alerts: readonly AlertDefinition[] = ALERTS,
): string[] {
  const problems: string[] = [];
  const check = (owner: string, query: Query) => {
    for (const { metric, labels } of referenced(query)) {
      const definition = (METRICS as Record<string, { type: string; labels: readonly string[] }>)[
        metric
      ];
      if (!definition) {
        problems.push(`${owner}: unknown metric ${metric}`);
        continue;
      }
      for (const label of labels) {
        if (!definition.labels.includes(label))
          problems.push(`${owner}: ${metric} has no label ${label}`);
        if ((FORBIDDEN_LABELS as readonly string[]).includes(label))
          problems.push(`${owner}: label ${label} may not be used`);
      }
    }
    const expected = { value: 'gauge', quantile: 'histogram' } as const;
    const kinds = (q: Query): Query[] =>
      q.kind === 'ratio' ? [...kinds(q.numerator), ...kinds(q.denominator)] : [q];
    for (const part of kinds(query)) {
      if (part.kind === 'ratio') continue;
      const type = (METRICS as Record<string, { type: string }>)[part.metric]?.type;
      if (part.kind === 'increase' ? type === 'gauge' : type !== expected[part.kind])
        problems.push(`${owner}: ${part.kind} cannot be used on ${part.metric} (${type})`);
      if (part.kind === 'quantile' && !(part.quantile > 0 && part.quantile < 1))
        problems.push(`${owner}: quantile must be between 0 and 1`);
    }
  };
  const ids = new Set<string>();
  for (const section of dashboard)
    for (const panel of section.panels) {
      if (ids.has(panel.id)) problems.push(`Duplicate panel ${panel.id}`);
      ids.add(panel.id);
      check(`panel ${panel.id}`, panel.query);
    }
  const alertIds = new Set<string>();
  for (const alert of alerts) {
    if (alertIds.has(alert.id)) problems.push(`Duplicate alert ${alert.id}`);
    alertIds.add(alert.id);
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(alert.id)) problems.push(`Alert id ${alert.id} is invalid`);
    if (!Number.isFinite(alert.threshold)) problems.push(`${alert.id}: threshold is not a number`);
    if (!isDuration(alert.for)) problems.push(`${alert.id}: invalid duration ${alert.for}`);
    check(`alert ${alert.id}`, alert.query);
  }
  return problems;
}

export function isDuration(value: unknown): value is Duration {
  return typeof value === 'string' && /^(0|[1-9]\d{0,4})[smhd]$/.test(value);
}
