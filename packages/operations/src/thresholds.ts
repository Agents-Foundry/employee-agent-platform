import {
  ALERTS,
  isDuration,
  type AlertDefinition,
  type Duration,
  type Severity,
} from './definitions.js';

/**
 * Deployment-specific alert settings (ADR 0039). A deployment may change an alert's threshold,
 * hold time and severity, or turn it off; it can never change what the alert measures. An
 * unknown alert, an unknown setting or a value of the wrong kind stops rendering: a typo must
 * not silently leave the recommended threshold, or no alert, in place.
 */
export interface AlertOverride {
  threshold?: number;
  for?: Duration;
  severity?: Severity;
  enabled?: boolean;
}

export interface AlertThresholds {
  version: 1;
  alerts: Record<string, AlertOverride>;
}

export interface ResolvedAlert extends AlertDefinition {
  enabled: boolean;
  /** Whether the deployment changed anything from the recommendation. */
  overridden: boolean;
}

const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];

export function parseThresholds(raw: unknown): AlertThresholds {
  const fail = (why: string): never => {
    throw new Error(`ALERT_THRESHOLDS_INVALID: ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  const { version, alerts, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) fail(`unknown field ${Object.keys(rest)[0]}`);
  if (version !== 1) fail('version must be 1');
  if (!alerts || typeof alerts !== 'object' || Array.isArray(alerts))
    fail('alerts must be an object');
  const known = new Set(ALERTS.map((alert) => alert.id));
  const result: Record<string, AlertOverride> = {};
  for (const [id, value] of Object.entries(alerts as Record<string, unknown>)) {
    if (!known.has(id)) fail(`unknown alert ${id}`);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail(`${id} must be an object`);
    const override: AlertOverride = {};
    for (const [field, setting] of Object.entries(value as Record<string, unknown>)) {
      if (field === 'threshold') {
        if (typeof setting !== 'number' || !Number.isFinite(setting) || setting < 0)
          fail(`${id}.threshold must be a non-negative number`);
        override.threshold = setting as number;
      } else if (field === 'for') {
        if (!isDuration(setting)) fail(`${id}.for must be a duration such as 15m`);
        override.for = setting as Duration;
      } else if (field === 'severity') {
        if (!SEVERITIES.includes(setting as Severity))
          fail(`${id}.severity must be critical, warning or info`);
        override.severity = setting as Severity;
      } else if (field === 'enabled') {
        if (typeof setting !== 'boolean') fail(`${id}.enabled must be true or false`);
        override.enabled = setting as boolean;
      } else fail(`${id} has unknown setting ${field}`);
    }
    result[id] = override;
  }
  return { version: 1, alerts: result };
}

export function resolveAlerts(thresholds?: AlertThresholds): ResolvedAlert[] {
  return ALERTS.map((alert) => {
    const override = thresholds?.alerts[alert.id] ?? {};
    return {
      ...alert,
      ...(override.threshold !== undefined ? { threshold: override.threshold } : {}),
      ...(override.for !== undefined ? { for: override.for } : {}),
      ...(override.severity !== undefined ? { severity: override.severity } : {}),
      enabled: override.enabled ?? true,
      overridden: Object.keys(override).length > 0,
    };
  });
}
