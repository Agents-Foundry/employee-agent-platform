import type { AnyAgentManifestPayload } from './index.js';
import { manifestApiVersions, type ManifestApiVersion } from './execution.js';

// Version 1 signing format: JSON values with ordinally sorted object keys.
// Shared by the server and employee client; array order is significant.
// Manifest v2 uses the identical canonical form and signing key (ADR 0004).
export function canonicalManifest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalManifest).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalManifest(object[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_MANIFEST_VALUE');
  return encoded;
}

export interface ManifestSubject {
  apiVersion: ManifestApiVersion;
  manifestId: string;
  agentId: string;
  organizationId: string;
  employeeId: string;
  issuedAt: string;
}

export function isSupportedManifestVersion(value: unknown): value is ManifestApiVersion {
  return (manifestApiVersions as readonly unknown[]).includes(value);
}

/** Identity fields used for ownership checks, independent of manifest version. */
export function manifestSubject(payload: AnyAgentManifestPayload): ManifestSubject {
  if (payload.apiVersion === 'agents-foundry/v2') {
    const { manifestId, agentId, organizationId, employeeId, issuedAt } = payload.metadata;
    return {
      apiVersion: payload.apiVersion,
      manifestId,
      agentId,
      organizationId,
      employeeId,
      issuedAt,
    };
  }
  if (payload.apiVersion === 'agents-foundry/v1') {
    const { apiVersion, manifestId, agentId, organizationId, employeeId, issuedAt } = payload;
    return { apiVersion, manifestId, agentId, organizationId, employeeId, issuedAt };
  }
  throw new Error('UNSUPPORTED_MANIFEST_VERSION');
}

/** Resolved installation answers (v1 `answers`, v2 `configuration`). */
export function manifestConfiguration(
  payload: AnyAgentManifestPayload,
): Record<string, string | string[]> {
  return payload.apiVersion === 'agents-foundry/v2' ? payload.configuration : payload.answers;
}
