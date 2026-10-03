import { readFileSync } from 'node:fs';
import {
  sanitizeAttributes,
  spanIdFor,
  traceIdForRun,
  type AttributeValue,
  type Attributes,
  type SpanSubject,
} from './attributes.js';
import {
  MetricRegistry,
  type CounterName,
  type GaugeName,
  type HistogramName,
  type Labels,
  type MetricFamily,
} from './metrics.js';

/** A finished span, in OpenTelemetry's terms. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  status: 'OK' | 'ERROR';
  attributes: Record<string, AttributeValue>;
}

/** Where finished spans go. Implementations never throw into the work being traced. */
export interface SpanExporter {
  export(span: SpanRecord): void;
  flush?(): Promise<void>;
}

export interface SpanInput {
  /** The run whose trace this span belongs to. */
  runId: string;
  name: string;
  /** What the span is about; gives it a stable identifier any process can refer to. */
  subject: SpanSubject;
  id: string;
  /** The parent's subject and identifier. Omitted: the run. The run span itself has none. */
  parent?: { subject: SpanSubject; id: string };
  startTimeMs: number;
  endTimeMs?: number;
  status?: 'OK' | 'ERROR';
  attributes?: Attributes;
}

/**
 * Provider-neutral tracing and metrics (ADR 0035). Traces follow the platform's own
 * correlation: a run is a trace, and steps, model calls, tool calls, action decisions,
 * approvals, grants, credential leases, execution operations, connector calls and artifacts
 * are spans named by their existing identifiers. Nothing here can fail or slow a request.
 */
export class Telemetry {
  readonly metrics = new MetricRegistry();

  constructor(
    readonly service: string,
    private readonly exporters: readonly SpanExporter[] = [],
  ) {}

  /** Record one finished span. */
  span(input: SpanInput): void {
    try {
      const end = input.endTimeMs ?? Date.now();
      const parent =
        input.subject === 'run' ? undefined : (input.parent ?? { subject: 'run', id: input.runId });
      const record: SpanRecord = {
        traceId: traceIdForRun(input.runId),
        spanId: spanIdFor(input.subject, input.id),
        ...(parent ? { parentSpanId: spanIdFor(parent.subject, parent.id) } : {}),
        name: /^[a-z][a-z0-9._]{0,63}$/.test(input.name) ? input.name : 'span',
        startTimeMs: Math.min(input.startTimeMs, end),
        endTimeMs: end,
        status: input.status ?? 'OK',
        attributes: sanitizeAttributes({ 'af.run.id': input.runId, ...input.attributes }, () =>
          this.metrics.count('af_telemetry_dropped_total', { kind: 'attribute' }),
        ),
      };
      for (const exporter of this.exporters) exporter.export(record);
    } catch {
      this.metrics.count('af_telemetry_dropped_total', { kind: 'span' });
    }
  }

  /** Time `work` as a span; an exception marks it as an error and is rethrown. */
  async trace<T>(
    input: Omit<SpanInput, 'startTimeMs' | 'endTimeMs' | 'status'>,
    work: () => Promise<T>,
    outcome?: (result: T) => { status?: 'OK' | 'ERROR'; attributes?: Attributes },
  ): Promise<T> {
    const startTimeMs = Date.now();
    try {
      const result = await work();
      const extra = outcome?.(result) ?? {};
      this.span({
        ...input,
        startTimeMs,
        status: extra.status ?? 'OK',
        attributes: { ...input.attributes, ...extra.attributes },
      });
      return result;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.span({
        ...input,
        startTimeMs,
        status: 'ERROR',
        attributes: {
          ...input.attributes,
          'error.code': typeof code === 'string' ? code : 'UNEXPECTED',
        },
      });
      throw error;
    }
  }

  count(name: CounterName, labels?: Labels, value = 1): void {
    this.metrics.count(name, labels, value);
  }

  observe(name: HistogramName, value: number, labels?: Labels): void {
    this.metrics.observe(name, value, labels);
  }

  gauge(name: GaugeName, collector: Parameters<MetricRegistry['gauge']>[1]): void {
    this.metrics.gauge(name, collector);
  }

  async flush(): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => exporter.flush?.().catch(() => undefined)));
  }
}

/** Keeps spans in memory (tests, and the failure drills' trace assertions). */
export class MemorySpanExporter implements SpanExporter {
  readonly spans: SpanRecord[] = [];

  export(span: SpanRecord): void {
    this.spans.push(span);
  }
}

/** One JSON line per span, for a log pipeline. */
export class JsonLineSpanExporter implements SpanExporter {
  constructor(
    private readonly service: string,
    private readonly write: (line: string) => void = (line) => console.log(line),
  ) {}

  export(span: SpanRecord): void {
    this.write(JSON.stringify({ telemetry: 'span', service: this.service, ...span }));
  }
}

export interface OtlpOptions {
  /** Collector base URL, for example `https://otel-collector.internal:4318`. */
  endpoint: string;
  service: string;
  /** Extra request headers (for example collector authentication), read on every request. */
  headers?: () => Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxQueue?: number;
  onDropped?: (kind: string, count: number) => void;
}

const nanos = (ms: number) => `${Math.round(ms)}000000`;
const otlpValue = (value: AttributeValue) =>
  typeof value === 'string'
    ? { stringValue: value }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value };
const otlpAttributes = (attributes: Record<string, AttributeValue>) =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));

function collectorUrl(endpoint: string, path: string): URL {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw new Error('TELEMETRY_ENDPOINT_HTTPS_REQUIRED');
  if (base.username || base.password) throw new Error('TELEMETRY_ENDPOINT_INVALID');
  return new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base);
}

/**
 * Sends spans and metrics to an OpenTelemetry collector over OTLP/HTTP JSON. Spans are queued
 * and sent in batches; when the collector is unreachable they are dropped and counted, never
 * retried into the request path.
 */
export class OtlpExporter implements SpanExporter {
  private queue: SpanRecord[] = [];
  private readonly traces: URL;
  private readonly metricsUrl: URL;

  constructor(private readonly options: OtlpOptions) {
    this.traces = collectorUrl(options.endpoint, '/v1/traces');
    this.metricsUrl = collectorUrl(options.endpoint, '/v1/metrics');
  }

  private get resource() {
    return { attributes: otlpAttributes({ 'service.name': this.options.service } as never) };
  }

  export(span: SpanRecord): void {
    if (this.queue.length >= (this.options.maxQueue ?? 2048)) {
      this.options.onDropped?.('span_queue', 1);
      return;
    }
    this.queue.push(span);
  }

  private async post(url: URL, body: unknown): Promise<boolean> {
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.options.headers?.() },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      await response.arrayBuffer().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }

  async flush(): Promise<void> {
    const spans = this.queue;
    if (!spans.length) return;
    this.queue = [];
    const sent = await this.post(this.traces, {
      resourceSpans: [
        {
          resource: this.resource,
          scopeSpans: [
            {
              scope: { name: 'agents-foundry' },
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: 1,
                startTimeUnixNano: nanos(span.startTimeMs),
                endTimeUnixNano: nanos(span.endTimeMs),
                attributes: otlpAttributes(span.attributes),
                status: { code: span.status === 'OK' ? 1 : 2 },
              })),
            },
          ],
        },
      ],
    });
    if (!sent) this.options.onDropped?.('span_export', spans.length);
  }

  /** Cumulative metrics since the process started. */
  async sendMetrics(families: MetricFamily[], startedAtMs: number): Promise<void> {
    if (!families.length) return;
    const now = nanos(Date.now());
    const start = nanos(startedAtMs);
    const point = (labels: Record<string, string>) => ({
      attributes: otlpAttributes(labels),
      startTimeUnixNano: start,
      timeUnixNano: now,
    });
    const sent = await this.post(this.metricsUrl, {
      resourceMetrics: [
        {
          resource: this.resource,
          scopeMetrics: [
            {
              scope: { name: 'agents-foundry' },
              metrics: families.map((family) => ({
                name: family.name,
                description: family.help,
                ...(family.unit ? { unit: family.unit === 'bytes' ? 'By' : family.unit } : {}),
                ...(family.type === 'counter'
                  ? {
                      sum: {
                        aggregationTemporality: 2,
                        isMonotonic: true,
                        dataPoints: family.points.map((item) => ({
                          ...point(item.labels),
                          asDouble: item.value,
                        })),
                      },
                    }
                  : family.type === 'gauge'
                    ? {
                        gauge: {
                          dataPoints: family.points.map((item) => ({
                            ...point(item.labels),
                            asDouble: item.value,
                          })),
                        },
                      }
                    : {
                        histogram: {
                          aggregationTemporality: 2,
                          dataPoints: family.points.map((item) => ({
                            ...point(item.labels),
                            count: String(item.count ?? 0),
                            sum: item.value,
                            explicitBounds: family.bounds,
                            // OTLP buckets are not cumulative; the last one is the overflow.
                            bucketCounts: [
                              ...item.buckets!.map((value, index) =>
                                String(value - (index ? item.buckets![index - 1]! : 0)),
                              ),
                              String((item.count ?? 0) - (item.buckets!.at(-1) ?? 0)),
                            ],
                          })),
                        },
                      }),
              })),
            },
          ],
        },
      ],
    });
    if (!sent) this.options.onDropped?.('metric_export', 1);
  }
}

export interface ConfiguredTelemetry {
  telemetry: Telemetry;
  /** Starts periodic export; returns a function that stops it and flushes. */
  start(intervalMs?: number): () => Promise<void>;
}

/**
 * `TELEMETRY_EXPORTER`: `none` (the default; metrics are still kept for `/metrics`), `console`
 * (one JSON line per span) or `otlp` (`OTEL_EXPORTER_OTLP_ENDPOINT`, with optional request
 * headers in the JSON file at `TELEMETRY_OTLP_HEADERS_PATH`). An unknown value refuses to start.
 */
export function telemetryFromEnvironment(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredTelemetry {
  const kind = env['TELEMETRY_EXPORTER']?.trim() || 'none';
  if (kind === 'none') {
    const telemetry = new Telemetry(service);
    return { telemetry, start: () => async () => undefined };
  }
  if (kind === 'console') {
    const telemetry = new Telemetry(service, [new JsonLineSpanExporter(service)]);
    return { telemetry, start: () => async () => undefined };
  }
  if (kind !== 'otlp') throw new Error('TELEMETRY_EXPORTER_INVALID');
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint) throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT_REQUIRED');
  const headersPath = env['TELEMETRY_OTLP_HEADERS_PATH']?.trim();
  let telemetry: Telemetry;
  const exporter = new OtlpExporter({
    endpoint,
    service,
    ...(headersPath
      ? {
          headers: () => {
            try {
              const parsed = JSON.parse(readFileSync(headersPath, 'utf8')) as unknown;
              return Object.fromEntries(
                Object.entries(parsed as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string',
                ),
              );
            } catch {
              return {};
            }
          },
        }
      : {}),
    onDropped: (dropped, count) =>
      telemetry.count('af_telemetry_dropped_total', { kind: dropped }, count),
  });
  telemetry = new Telemetry(service, [exporter]);
  return {
    telemetry,
    start: (intervalMs = 10_000) => {
      const push = async () => {
        await exporter.flush();
        await exporter.sendMetrics(
          await telemetry.metrics.collect(),
          telemetry.metrics.startedAtMs,
        );
      };
      const timer = setInterval(() => void push().catch(() => undefined), intervalMs);
      timer.unref();
      return async () => {
        clearInterval(timer);
        await push().catch(() => undefined);
      };
    },
  };
}
