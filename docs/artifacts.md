# Artifacts

Artifacts are the first-class outputs and evidence of runs: screenshots, Playwright traces,
logs, reports, patches, defect drafts and so on. Contracts live in
`packages/contracts/src/artifacts.ts`, and records live in `agent_artifacts` (migration 006).

## Status

- Implemented: the metadata model, validation, tenant/run/step scoping, registration through
  the runtime `artifact.created` event, and browser-safe listing on run detail.
- Not implemented: an artifact store, uploads, signed downloads, retention enforcement and
  evidence capture. Nothing produces artifacts until the execution runtime exists (Phase E).

## Model

| Field              | Notes                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| `id`               | UUID chosen by the producer, so registration is idempotent             |
| `organizationId`, `threadId`, `runId`, `stepId` | The step must belong to the run, and the run to the thread and tenant (triggers) |
| `type`, `mediaType`, `name` | A closed type list, a MIME type, and a file name with no path separators |
| `storageReference` | `artifact://<store>/<opaque-key>` only                                  |
| `checksum`         | SHA-256                                                                 |
| `sizeBytes`        | Up to 5 GiB                                                             |
| `retentionPolicy`  | `EPHEMERAL`, `STANDARD_30D`, `EXTENDED_365D` or `LEGAL_HOLD`            |

## Security rules

- Binary content is never stored in application tables. There is no blob column.
- The storage-reference pattern rejects `file:`, `data:`, `http(s):` (including embedded
  credentials) and `..` traversal. A store resolves references with its own tenant-scoped
  credentials.
- Storage references are **not** returned to browsers (`ArtifactSummary` omits them) and are not
  copied into event history. Downloads will go through a future authorized, signed-URL endpoint.
- Artifact rows are immutable. Update and delete are blocked by triggers. Retention deletion
  needs a governed path, added with the store.
