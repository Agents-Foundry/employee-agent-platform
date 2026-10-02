import { createHash } from 'node:crypto';

/**
 * Telemetry carries identifiers and measurements, never content (ADR 0035). The attribute
 * names are a closed list, and a string value must look like an identifier: no spaces, no
 * quotes, at most 128 characters. A prompt, a model response, a file or an error message
 * therefore cannot be attached to a span or a metric, whatever a caller passes.
 */
export const ATTRIBUTE_KEYS = [
  // Correlation: the identifiers the platform already assigns.
  'af.organization.id',
  'af.thread.id',
  'af.run.id',
  'af.step.id',
  'af.tool_call.id',
  'af.request.id',
  'af.approval.id',
  'af.grant.id',
  'af.lease.id',
  'af.artifact.id',
  'af.reservation.id',
  'af.runtime.id',
  // Classification.
  'af.step.kind',
  'af.tool.id',
  'af.action',
  'af.decision',
  'af.risk',
  'af.status',
  'af.reason',
  'af.command',
  'af.operation.kind',
  'af.isolation',
  'af.provider',
  'af.connector.provider',
  'af.model.provider',
  'af.model.name',
  'af.model.profile',
  'af.artifact.media_type',
  'af.artifact.retention',
  'af.artifact.source',
  'af.store',
  'af.secret.provider',
  'error.code',
  // Measurements.
  'af.model.input_tokens',
  'af.model.output_tokens',
  'af.model.cost_micros',
  'af.artifact.size_bytes',
  'af.checkpoint.version',
  'af.checkpoint.bytes',
  'af.recoveries',
  'af.egress.denied',
  'af.http.status',
  'af.exit_code',
  'af.attempts',
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];
export type AttributeValue = string | number | boolean;
export type Attributes = Partial<Record<AttributeKey, AttributeValue | null | undefined>>;

const allowed: ReadonlySet<string> = new Set(ATTRIBUTE_KEYS);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** Keeps the listed keys whose values are finite numbers, booleans or identifier-like text. */
export function sanitizeAttributes(
  attributes: Attributes | undefined,
  onDropped?: () => void,
): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  if (!attributes) return result;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    const valid =
      allowed.has(key) &&
      (typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && identifier.test(value)));
    if (valid) result[key] = value;
    else onDropped?.();
  }
  return result;
}

/** What a span is about; with the identifier it names one span in a run's trace. */
export type SpanSubject =
  | 'run'
  | 'step'
  | 'model'
  | 'reservation'
  | 'tool'
  | 'action'
  | 'approval'
  | 'grant'
  | 'lease'
  | 'operation'
  | 'dispatch'
  | 'artifact'
  | 'checkpoint';

const hex = (text: string, length: number) =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, length);

/**
 * A run is one trace. Its identifier is derived from the run identifier, so the control plane,
 * the agent runtime and the execution runtime write into the same trace without passing
 * tracing headers to each other.
 */
export function traceIdForRun(runId: string): string {
  return hex(`agents-foundry/trace/${runId}`, 32);
}

/**
 * Span identifiers are derived from the identifier the platform already gave the thing: a
 * step, a tool call, an action request, a grant, a lease, an artifact. Any process can name a
 * span's parent from the correlation it holds.
 */
export function spanIdFor(subject: SpanSubject, id: string): string {
  return hex(`agents-foundry/span/${subject}/${id}`, 16);
}
