/**
 * Every metric the platform reports (ADR 0035). Names, label names and help text are fixed
 * here; a service cannot add a label or a metric at a call site. Label values are short
 * identifiers: run, thread and person identifiers never label a metric.
 */
interface Definition {
  type: 'counter' | 'histogram' | 'gauge';
  help: string;
  labels: readonly string[];
  unit?: 'ms' | 'bytes';
}

const define = <T extends Record<string, Definition>>(definitions: T): T => definitions;

export const METRICS = define({
  // Runs.
  af_runs: { type: 'gauge', help: 'Runs by status.', labels: ['status'] },
  af_runs_created_total: { type: 'counter', help: 'Runs queued.', labels: [] },
  af_runs_finished_total: {
    type: 'counter',
    help: 'Runs that completed, failed or were cancelled.',
    labels: ['status', 'reason'],
  },
  af_run_duration_ms: {
    type: 'histogram',
    help: 'Time from a run being queued to its end.',
    labels: ['status'],
    unit: 'ms',
  },
  af_run_queue_wait_ms: {
    type: 'histogram',
    help: 'Time a run waited for a runtime.',
    labels: [],
    unit: 'ms',
  },
  // Leases and recovery.
  af_runtime_leases: { type: 'gauge', help: 'Run leases by state.', labels: ['state'] },
  af_runtime_leases_expired_total: {
    type: 'counter',
    help: 'Run leases found expired.',
    labels: ['status'],
  },
  af_run_recoveries_total: {
    type: 'counter',
    help: 'Runs handed to a runtime after their lease expired.',
    labels: ['command'],
  },
  af_runs_abandoned_total: {
    type: 'counter',
    help: 'Abandoned runs that were cancelled.',
    labels: ['code'],
  },
  // Checkpoints.
  af_checkpoint_writes_total: { type: 'counter', help: 'Checkpoint saves.', labels: ['result'] },
  af_checkpoint_reads_total: { type: 'counter', help: 'Checkpoint loads.', labels: ['result'] },
  af_checkpoint_bytes: {
    type: 'histogram',
    help: 'Size of saved checkpoints.',
    labels: [],
    unit: 'bytes',
  },
  // Models.
  af_model_latency_ms: {
    type: 'histogram',
    help: 'Model call latency.',
    labels: ['provider', 'model'],
    unit: 'ms',
  },
  af_model_calls_total: {
    type: 'counter',
    help: 'Model calls.',
    labels: ['provider', 'model', 'result'],
  },
  af_model_tokens_total: {
    type: 'counter',
    help: 'Tokens settled against spending limits.',
    labels: ['provider', 'model', 'direction'],
  },
  af_model_cost_micros_total: {
    type: 'counter',
    help: 'Settled model cost, in millionths of the currency.',
    labels: ['provider', 'model', 'currency'],
  },
  af_model_budget_decisions_total: {
    type: 'counter',
    help: 'Model spending reservations decided.',
    labels: ['decision', 'code'],
  },
  // Tools and governed actions.
  af_tool_calls_total: { type: 'counter', help: 'Tool calls.', labels: ['tool', 'result'] },
  af_tool_duration_ms: {
    type: 'histogram',
    help: 'Tool call duration.',
    labels: ['tool', 'result'],
    unit: 'ms',
  },
  af_action_decisions_total: {
    type: 'counter',
    help: 'Action Gateway decisions.',
    labels: ['action', 'decision'],
  },
  af_action_executions_total: {
    type: 'counter',
    help: 'Control-plane action executions.',
    labels: ['action', 'status', 'code'],
  },
  af_action_reconciliations_total: {
    type: 'counter',
    help: 'Actions whose outcome needs, or was given, a manual reconciliation.',
    labels: ['action', 'event'],
  },
  af_approvals_total: { type: 'counter', help: 'Approvals decided.', labels: ['action', 'status'] },
  af_approval_wait_ms: {
    type: 'histogram',
    help: 'Time an approval waited for a decision.',
    labels: ['action', 'status'],
    unit: 'ms',
  },
  // Execution.
  af_execution_grants_total: {
    type: 'counter',
    help: 'Execution grants issued or refused.',
    labels: ['operation', 'result'],
  },
  af_execution_operations_total: {
    type: 'counter',
    help: 'Execution-runtime operations.',
    labels: ['kind', 'status', 'code'],
  },
  af_execution_duration_ms: {
    type: 'histogram',
    help: 'Execution-runtime operation duration.',
    labels: ['kind', 'status'],
    unit: 'ms',
  },
  af_execution_in_flight: {
    type: 'gauge',
    help: 'Operations an execution runtime is running.',
    labels: [],
  },
  af_execution_refusals_total: {
    type: 'counter',
    help: 'Requests an execution runtime refused before running anything.',
    labels: ['code'],
  },
  af_sandbox_startup_ms: {
    type: 'histogram',
    help: 'Time to prepare a sandbox before the operation started.',
    labels: ['provider'],
    unit: 'ms',
  },
  af_egress_denials_total: {
    type: 'counter',
    help: 'Connections the egress proxy refused.',
    labels: ['provider'],
  },
  af_egress_failures_total: {
    type: 'counter',
    help: 'Operations refused because egress control was unavailable.',
    labels: ['code'],
  },
  // Credentials and secrets.
  af_credential_leases_total: {
    type: 'counter',
    help: 'Repository credential lease events.',
    labels: ['event', 'code'],
  },
  af_secret_resolutions_total: {
    type: 'counter',
    help: 'Secret resolutions.',
    labels: ['provider', 'result'],
  },
  af_secret_resolution_ms: {
    type: 'histogram',
    help: 'Secret resolution latency.',
    labels: ['provider'],
    unit: 'ms',
  },
  // Connectors.
  af_connector_duration_ms: {
    type: 'histogram',
    help: 'Connector call duration.',
    labels: ['provider', 'action', 'outcome'],
    unit: 'ms',
  },
  af_connector_errors_total: {
    type: 'counter',
    help: 'Connector calls that failed.',
    labels: ['provider', 'action', 'code'],
  },
  // Artifacts.
  af_artifact_uploads_total: {
    type: 'counter',
    help: 'Artifact uploads.',
    labels: ['source', 'result'],
  },
  af_artifact_upload_bytes_total: {
    type: 'counter',
    help: 'Artifact bytes stored.',
    labels: ['source'],
    unit: 'bytes',
  },
  af_artifact_retrievals_total: {
    type: 'counter',
    help: 'Artifact retrievals.',
    labels: ['result'],
  },
  af_artifact_integrity_failures_total: {
    type: 'counter',
    help: 'Artifacts whose bytes did not match their record.',
    labels: ['code'],
  },
  af_artifact_deletions_total: {
    type: 'counter',
    help: 'Artifacts whose bytes were deleted.',
    labels: ['reason'],
  },
  af_object_store_failures_total: {
    type: 'counter',
    help: 'Artifact store operations that failed.',
    labels: ['operation'],
  },
  // The platform's own dependencies.
  af_database_retries_total: {
    type: 'counter',
    help: 'Database transactions retried.',
    labels: ['reason'],
  },
  af_runtime_control_plane_retries_total: {
    type: 'counter',
    help: 'Control-plane requests an agent runtime repeated.',
    labels: ['operation'],
  },
  af_runtime_active_runs: {
    type: 'gauge',
    help: 'Runs an agent runtime is executing.',
    labels: [],
  },
  af_telemetry_dropped_total: {
    type: 'counter',
    help: 'Telemetry that was refused or could not be exported.',
    labels: ['kind'],
  },
});

export type MetricName = keyof typeof METRICS;
type NamesOf<T extends Definition['type']> = {
  [K in MetricName]: (typeof METRICS)[K]['type'] extends T ? K : never;
}[MetricName];
export type CounterName = NamesOf<'counter'>;
export type HistogramName = NamesOf<'histogram'>;
export type GaugeName = NamesOf<'gauge'>;
export type Labels = Record<string, string | number | null | undefined>;

const MS_BUCKETS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, 1_800_000,
];
const BYTE_BUCKETS = [1024, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864];
/** A metric keeps at most this many label combinations; further ones are dropped. */
export const MAX_SERIES = 500;

const labelValue = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

export interface MetricPoint {
  labels: Record<string, string>;
  value: number;
  /** Histograms only. */
  count?: number;
  buckets?: number[];
}

export interface MetricFamily {
  name: MetricName;
  type: Definition['type'];
  help: string;
  unit?: string;
  bounds?: readonly number[];
  points: MetricPoint[];
}

type GaugeCollector = () => Promise<{ labels?: Labels; value: number }[]>;

/** In-process metric state. Reading it never blocks or fails the work being measured. */
export class MetricRegistry {
  private readonly series = new Map<MetricName, Map<string, MetricPoint>>();
  private readonly collectors = new Map<GaugeName, GaugeCollector>();
  readonly startedAtMs = Date.now();

  private point(name: MetricName, labels: Labels | undefined): MetricPoint | null {
    const definition: Definition = METRICS[name];
    const clean: Record<string, string> = {};
    for (const label of definition.labels) {
      const value = labels?.[label];
      const text = value === null || value === undefined ? 'none' : String(value);
      clean[label] = labelValue.test(text) ? text : 'other';
    }
    const key = definition.labels.map((label) => clean[label]).join('\u0000');
    let family = this.series.get(name);
    if (!family) this.series.set(name, (family = new Map()));
    let point = family.get(key);
    if (!point) {
      if (family.size >= MAX_SERIES) {
        if (name !== 'af_telemetry_dropped_total')
          this.count('af_telemetry_dropped_total', { kind: 'metric_series' });
        return null;
      }
      const bounds = this.bounds(name);
      point = {
        labels: clean,
        value: 0,
        ...(bounds ? { count: 0, buckets: bounds.map(() => 0) } : {}),
      };
      family.set(key, point);
    }
    return point;
  }

  private bounds(name: MetricName): readonly number[] | undefined {
    const definition: Definition = METRICS[name];
    if (definition.type !== 'histogram') return undefined;
    return definition.unit === 'bytes' ? BYTE_BUCKETS : MS_BUCKETS;
  }

  count(name: CounterName, labels?: Labels, value = 1): void {
    if (!Number.isFinite(value) || value < 0) return;
    const point = this.point(name, labels);
    if (point) point.value += value;
  }

  observe(name: HistogramName, value: number, labels?: Labels): void {
    if (!Number.isFinite(value) || value < 0) return;
    const point = this.point(name, labels);
    if (!point) return;
    point.value += value;
    point.count = (point.count ?? 0) + 1;
    const bounds = this.bounds(name)!;
    for (let index = 0; index < bounds.length; index += 1)
      if (value <= bounds[index]!) point.buckets![index]! += 1;
  }

  /** Gauges are read when metrics are collected, so they are never stale. */
  gauge(name: GaugeName, collector: GaugeCollector): void {
    this.collectors.set(name, collector);
  }

  async collect(): Promise<MetricFamily[]> {
    for (const [name, collector] of this.collectors) {
      let values: Awaited<ReturnType<GaugeCollector>>;
      try {
        values = await collector();
      } catch {
        this.count('af_telemetry_dropped_total', { kind: 'gauge_collection' });
        continue;
      }
      this.series.delete(name);
      for (const item of values) {
        const point = this.point(name, item.labels);
        if (point && Number.isFinite(item.value)) point.value = item.value;
      }
    }
    return (Object.keys(METRICS) as MetricName[]).flatMap((name) => {
      const family = this.series.get(name);
      if (!family?.size) return [];
      const definition: Definition = METRICS[name];
      const bounds = this.bounds(name);
      return [
        {
          name,
          type: definition.type,
          help: definition.help,
          ...(definition.unit ? { unit: definition.unit } : {}),
          ...(bounds ? { bounds } : {}),
          points: [...family.values()].map((point) => ({
            ...point,
            ...(point.buckets ? { buckets: [...point.buckets] } : {}),
          })),
        },
      ];
    });
  }

  /** Prometheus text exposition format, version 0.0.4. */
  async prometheus(): Promise<string> {
    const lines: string[] = [];
    const render = (labels: Record<string, string>, extra?: [string, string]) => {
      const pairs = [...Object.entries(labels), ...(extra ? [extra] : [])].map(
        ([name, value]) => `${name}="${value}"`,
      );
      return pairs.length ? `{${pairs.join(',')}}` : '';
    };
    for (const family of await this.collect()) {
      lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`);
      for (const point of family.points) {
        if (family.type !== 'histogram') {
          lines.push(`${family.name}${render(point.labels)} ${point.value}`);
          continue;
        }
        family.bounds!.forEach((bound, index) =>
          lines.push(
            `${family.name}_bucket${render(point.labels, ['le', String(bound)])} ${point.buckets![index]}`,
          ),
        );
        lines.push(
          `${family.name}_bucket${render(point.labels, ['le', '+Inf'])} ${point.count}`,
          `${family.name}_sum${render(point.labels)} ${point.value}`,
          `${family.name}_count${render(point.labels)} ${point.count}`,
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
