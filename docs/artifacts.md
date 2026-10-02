# Artifacts

Artifacts are the first-class outputs and evidence of runs: screenshots, Playwright traces,
logs, reports, patches, defect drafts and so on. Contracts live in
`packages/contracts/src/artifacts.ts`. The registration lives in `agent_artifacts`, the stored
object and its lifecycle in `agent_artifact_objects`, and the bytes in the artifact store.
See [ADR 0033](adr/0033-durable-artifact-storage.md).

## Status

- Implemented: the metadata model, tenant/run/step scoping, uploads from agent and execution
  runtimes through the signed transport, hash verification, registration through the runtime
  `artifact.created` event, browser-safe listing on run detail, short-lived authorized
  retrieval, and retention enforcement.
- Not implemented: a download control in the web or desktop applications, deletion on request,
  uploads larger than 16 MiB, and application-level encryption.

## Model

| Field                                           | Notes                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `id`                                            | UUID chosen by the producer, used once across all organizations                  |
| `organizationId`, `threadId`, `runId`, `stepId` | The step must belong to the run, and the run to the thread and tenant (triggers) |
| `type`, `mediaType`, `name`                     | A closed type list, a MIME type, and a file name with no path separators         |
| `storageReference`                              | `artifact://<store>/<opaque-key>` only                                           |
| `checksum`                                      | SHA-256                                                                          |
| `sizeBytes`                                     | Up to 16 MiB for content the control plane stores                                |
| `retentionPolicy`                               | `EPHEMERAL`, `STANDARD_30D`, `EXTENDED_365D` or `LEGAL_HOLD`                     |
| `content`                                       | `AVAILABLE`, `DELETED` or `UNMANAGED`, with expiry and deletion time and reason  |

## Stores

| `ARTIFACT_STORE`  | Adapter              | Use                                                                                       |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `local` (default) | `LocalArtifactStore` | Files under `ARTIFACT_STORE_DIR`. Development                                             |
| `s3`              | `S3ArtifactStore`    | S3-compatible object store: Amazon S3, Google Cloud Storage (interoperability API), MinIO |

The S3 adapter needs `ARTIFACT_S3_ENDPOINT`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_BUCKET` and
`ARTIFACT_S3_CREDENTIALS_PATH` (a JSON file with `accessKeyId`, `secretAccessKey` and optionally
`sessionToken`, read on every request). `ARTIFACT_S3_PREFIX` is optional. The bucket must be
private.

## Flow

1. A runtime uploads the bytes with their declared size and SHA-256
   (`POST /runtime/v1/artifacts`, or `/runtime/v1/artifacts/execution` with a signed grant).
   The control plane verifies both, writes the object under
   `<organization>/<run>/<artifact id>` and returns the reference.
2. The run registers the artifact with `artifact.created`. A reference to the control plane's
   store is accepted only if it matches the stored object exactly.
3. The owning employee, or an administrator of the organization, asks for a retrieval
   (`POST /api/execution/v1/artifacts/:id/retrievals`) and downloads from the returned path
   within 60 seconds, with the same session.
4. When the retention class expires, the bytes are deleted and the object is marked `DELETED`
   with the time and reason. The metadata stays.

## Security rules

- Binary content is never stored in application tables. There is no blob column.
- Only the control plane holds object-store credentials. Runtimes, agents and workspaces never
  see them, the storage key or an object URL.
- The storage-reference pattern rejects `file:`, `data:`, `http(s):` (including embedded
  credentials) and `..` traversal. Storage keys are the control plane's own and always start
  with the organization.
- Storage references are **not** returned to browsers (`ArtifactSummary` omits them) and are not
  copied into event history.
- Bytes are checked against their SHA-256 on upload, on registration and on retrieval.
- Metadata and lifecycle rows are under forced row-level security. A retrieval permission is
  signed, names one artifact, organization, person and hash, and is useless to anyone else.
- Registration rows are immutable. Lifecycle rows only move forward and are never removed.
