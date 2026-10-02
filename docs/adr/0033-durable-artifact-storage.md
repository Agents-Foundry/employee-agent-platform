# ADR 0033: Durable artifact storage

- Status: Accepted
- Date: 2026-10-01

## Context

Artifacts were metadata only. Each runtime wrote the bytes to its own disk and registered an
opaque reference. Nobody could download an artifact, nothing checked that the bytes matched the
registered hash, and nothing enforced the retention policy.

## Decision

1. **`ArtifactStore`** is the control plane's interface to where bytes live: `put`, `get` and
   `delete` by key. Adapters:
   - `LocalArtifactStore` (`ARTIFACT_STORE=local`, the default): files under
     `ARTIFACT_STORE_DIR`. Development.
   - `S3ArtifactStore` (`ARTIFACT_STORE=s3`): an S3-compatible object store over HTTPS with AWS
     Signature Version 4: Amazon S3, Google Cloud Storage through its interoperability API, or
     MinIO. The bucket is private. Credentials are read from a file on every request
     (`ARTIFACT_S3_CREDENTIALS_PATH`), as a workload identity or secrets agent writes them.
2. **Only the control plane holds store credentials.** Runtimes upload through the signed
   transport. Agents, model context and execution workspaces never see the store, its
   credentials or an object URL.
3. **Bytes live outside PostgreSQL.** `agent_artifact_objects` keeps the organization, run,
   thread, step and tool call, media type, size, SHA-256, retention class, creation time,
   storage key and lifecycle. `agent_artifacts` remains the immutable registration.
4. **Uploads are authorized twice over.**
   - An agent runtime uploads to `POST /runtime/v1/artifacts` for a running step of a run it
     holds the lease for.
   - An execution runtime uploads evidence to `POST /runtime/v1/artifacts/execution` with the
     signed execution grant. The tenant, run, step and tool call come from the grant, which
     must be one the control plane recorded for a run that is still running.
5. **The key is the control plane's**: `<organization>/<run>/<artifact id>`. No request can
   name a key. An artifact id is used once across all organizations.
6. **Hashes are verified three times**: when the bytes are uploaded (size and SHA-256 against
   what the runtime declared), when the run registers the artifact (`artifact.created` must
   match the stored object's id, key, hash, size, media type and retention), and when the
   content is retrieved (the bytes read from the store against the recorded hash). A mismatch
   at retrieval returns nothing and is audited as `artifact.integrity_failed`.
7. **Retrieval is short-lived and personal.** `POST /api/execution/v1/artifacts/:id/retrievals`
   authorizes the signed-in person as for the artifact's metadata (the owning employee, or an
   administrator of the organization) and returns a path valid for 60 seconds. The permission
   is signed by the control plane and names the artifact, the organization, the person and the
   hash. `GET` on that path requires the same person's session, authorizes again and streams
   the bytes as a download. There are no public or permanent object URLs. Every permission and
   retrieval is audited.
8. **Tenant isolation.** The metadata is under forced row-level security. The API resolves
   artifact ids only inside the caller's organization, so a guessed id or key leads nowhere. A
   row whose key is not under its own organization's prefix is refused.
9. **Retention is enforced.** Each object has an expiry from its retention class: `EPHEMERAL`
   one day, `STANDARD_30D`, `EXTENDED_365D`, and none for `LEGAL_HOLD`. Once a minute the API
   process deletes the bytes of expired artifacts and of uploads no run registered within a
   day, then marks the row `DELETED` with the time and reason, and audits `artifact.deleted`.
   Bytes are removed before the row is marked. Rows are never removed.
10. **Unmanaged content.** A runtime configured with a local store still registers
    `artifact://<its-store>/…` references. They are accepted as before, shown as `UNMANAGED`
    and cannot be retrieved. `ARTIFACTS_REQUIRE_MANAGED=true` refuses them.

## Lifecycle

`PENDING` (bytes being written) → `STORED` → `REGISTERED` → `DELETED`. `PENDING` and `STORED`
objects also go to `DELETED` if they are never registered. A trigger allows only these moves.

## Consequences

- One artifact is at most 16 MiB, one run at most 200 artifacts and 512 MiB, because bytes
  travel through the signed transport as base64. Larger evidence (long videos) is reported as
  not stored. Direct-to-store uploads are future work.
- The control plane buffers each artifact in memory on upload and download.
- Evidence an execution runtime cannot upload is dropped, and the operation's output says so.
- Objects are not encrypted by the application; use the store's own encryption at rest.
- Deleting an organization's or an employee's artifacts on request is not implemented; only
  retention deletes.
