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
