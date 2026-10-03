// First-class artifacts: metadata and an opaque storage reference, never inline binaries.

export const artifactTypes = [
  'source_patch',
  'test_report',
  'screenshot',
  'playwright_trace',
  'video',
  'console_log',
  'network_log',
  'log',
  'document',
  'spreadsheet',
  'report',
  'generated_code',
  'pull_request_reference',
  'defect_draft',
  'analysis_report',
] as const;
export type ArtifactType = (typeof artifactTypes)[number];

export const artifactRetentionPolicies = [
  'EPHEMERAL',
  'STANDARD_30D',
  'EXTENDED_365D',
  'LEGAL_HOLD',
] as const;
export type ArtifactRetentionPolicy = (typeof artifactRetentionPolicies)[number];

/**
 * `artifact://<store>/<key>`: the store resolves it with its own tenant-scoped credentials.
 * The key is opaque; local paths, data URIs and credential-bearing URLs are never stored.
 */
export const artifactStorageReferencePattern =
  /^artifact:\/\/[a-z0-9][a-z0-9-]{0,62}\/(?!.*\.\.)[A-Za-z0-9._\-/]{1,512}$/;

/** What a runtime submits when it registers an artifact it has already stored. */
export interface ArtifactRegistration {
  id: string;
  type: ArtifactType;
  mediaType: string;
  name: string;
  storageReference: string;
  checksum: { algorithm: 'sha256'; value: string };
  sizeBytes: number;
  retentionPolicy: ArtifactRetentionPolicy;
}

export interface Artifact extends ArtifactRegistration {
  organizationId: string;
  threadId: string;
  runId: string;
  stepId: string | null;
  createdAt: string;
  createdBy: string;
}

/**
 * Whether an artifact's bytes can be retrieved (ADR 0033). `UNMANAGED` artifacts were stored
 * by a runtime on its own host and cannot be retrieved through the control plane.
 */
export type ArtifactContentState = 'AVAILABLE' | 'DELETED' | 'UNMANAGED';

export interface ArtifactContent {
  state: ArtifactContentState;
  /** When retention removes the bytes; null for a legal hold or unmanaged content. */
  expiresAt: string | null;
  deletedAt: string | null;
  deletionReason: string | null;
}

/** Browser-safe view: storage references are not exposed to Angular clients. */
export type ArtifactSummary = Omit<Artifact, 'storageReference'> & { content?: ArtifactContent };

/** Largest artifact a runtime can upload through the signed transport. */
export const MAX_ARTIFACT_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Largest artifact an execution runtime can upload directly to the artifact store (ADR 0037):
 * browser traces and screenshots do not fit the base64 transport.
 */
export const MAX_DIRECT_ARTIFACT_BYTES = 128 * 1024 * 1024;

/** What may be uploaded directly. Anything else goes through the signed transport or not at all. */
export const directUploadMediaTypes = [
  'application/zip',
  'application/json',
  'application/x-ndjson',
  'image/png',
  'image/jpeg',
  'text/plain',
  'video/webm',
] as const;

/**
 * Permission to upload one artifact's bytes straight to the artifact store (ADR 0037). It is
 * for one object key, one size, one SHA-256 and one media type, and lasts minutes. It contains
 * a signature, never a store credential.
 *
 * `STORE`: send `PUT url` with exactly `headers`. `CONTROL_PLANE`: the store cannot authorize
 * uploads itself, so `url` is a control-plane path the runtime sends a signed `PUT` to.
 */
export interface ArtifactUploadAuthorization {
  artifactId: string;
  target: 'STORE' | 'CONTROL_PLANE';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

/** What a runtime declares about the bytes it uploads; the control plane verifies all of it. */
export interface ArtifactUploadDescriptor {
  id: string;
  mediaType: string;
  name: string;
  checksum: { algorithm: 'sha256'; value: string };
  sizeBytes: number;
  retentionPolicy: ArtifactRetentionPolicy;
}

/** The stored object: the reference to register with `artifact.created`. */
export interface ArtifactUpload {
  artifactId: string;
  storageReference: string;
  checksum: { algorithm: 'sha256'; value: string };
  sizeBytes: number;
}

/**
 * A short-lived permission for one signed-in person to download one artifact. The path works
 * only for that person, in that organization, until `expiresAt`.
 */
export interface ArtifactRetrieval {
  artifactId: string;
  path: string;
  expiresAt: string;
}

/** Links a claim (for example a defect or approval request) to supporting artifacts. */
export interface EvidenceReference {
  artifactId: string;
  description: string;
}
