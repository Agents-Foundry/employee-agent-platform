# ADR 0037: Direct artifact upload, and richer browser evidence

- Status: Accepted
- Date: 2026-10-02

## Context

A Playwright run produced one artifact: its JSON report. The evidence a person needs to
understand a failed browser test is the trace, the screenshots and what the network did.

Those do not fit the upload path of ADR 0033, which carries bytes as base64 inside a signed
JSON request of at most 16 MiB. A trace is routinely tens of megabytes.

## Decision

### Evidence

For `playwright.run`, both providers now:

- run Playwright with `--output` set to a directory created for that run inside the project,
  and `--trace=retain-on-failure`;
- collect from that directory, then remove it: traces (`trace.zip`), screenshots (PNG, JPEG)
  and videos (WebM), where the project produced them;
- keep the JSON report, and what the test process printed, as `playwright-console.log`. The
  browser's own console is inside each trace;
- with the container provider, keep the egress proxy's log as `network_log`: every
  destination the run tried, allowed or refused, at most a thousand entries, never a request
  body or header.

The test code controls those files, so nothing trusts their names or sizes. Only regular
files that really are inside the directory are read; links are not followed.

| Evidence         | Per file | Files | Retention       |
| ---------------- | -------- | ----- | --------------- |
| Trace            | 48 MiB   | 4     | `STANDARD_30D`  |
| Screenshot       | 4 MiB    | 20    | `STANDARD_30D`  |
| Video            | 24 MiB   | 2     | `EPHEMERAL`     |
| Report           |          | 1     | `EXTENDED_365D` |
| Console, network |          | 1     | `STANDARD_30D`  |

All browser evidence of one run together is at most 160 MiB, and the run's existing quotas
(200 artifacts, 512 MiB) still apply. What is over a limit is left out, and the tool result
says how many files were not kept.

### Direct upload

Every artifact still goes through the control plane's `ArtifactStore`. For one larger than
4 MiB, of an allowed media type, an execution runtime:

1. **asks for permission** (`POST /runtime/v1/artifacts/execution/authorize`) with the signed
   execution grant and the artifact's identifier, media type, size and SHA-256. The control
   plane checks the grant as for any upload (signed by it, recorded, run still running, runtime
   serves that organization), applies the run's quotas, and reserves the object as `PENDING`
   under `<organization>/<run>/<artifact id>` for the grant's step and tool call;
2. **sends the bytes** where the permission says;
3. **confirms** (`POST /runtime/v1/artifacts/execution/complete`). The control plane reads the
   object back and accepts it only if its size and SHA-256 are exactly what was declared.
   Anything else is deleted and recorded as an integrity failure, and can never be registered.

The permission is:

| Property                 | How                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant scoped            | The key starts with the organization of the signed grant; the request cannot name one                                                             |
| Run, step, tool scoped   | Taken from the grant; the object row records them                                                                                                 |
| Short lived              | The store's signature window (15 minutes) or, on the control plane's own path, 5 minutes                                                          |
| Size limited             | At most 128 MiB; the exact length is part of the signature                                                                                        |
| Content-type limited     | A closed list (zip, JSON, NDJSON, PNG, JPEG, plain text, WebM); the type is part of the signature                                                 |
| Bound to id and checksum | The key contains the artifact id; the payload's SHA-256 is part of the signature, and is checked again by the control plane when it reads it back |

**With an S3-compatible store**, the permission is the set of headers of one AWS Signature
Version 4 `PUT`: the payload hash, length, media type and key are all signed, so the store
itself refuses any other bytes. The store's secret key never leaves the control plane; the
runtime receives a signature.

**With a store that cannot do this** (the local development store), the permission is a path
on the control plane with a token signed by the control-plane key, domain-separated from every
other signature. The runtime sends the raw bytes there with its own workload signature; only
the runtime the token was issued to is accepted, and only the declared bytes are stored.

The runtime refuses a permission that points anywhere but an HTTPS store or that upload path,
and never repeats what a store answered.

## Consequences

- An object that was authorized and never confirmed stays `PENDING` and is removed by
  retention after a day, like any upload no run registered.
- The control plane reads an uploaded object fully into memory to verify it, as it does on
  retrieval: up to 128 MiB per request.
- Only execution runtimes upload directly. Agent runtimes store text they wrote, which fits
  the signed transport.
- Screenshots depend on the project's Playwright configuration; the platform does not rewrite
  it. Traces are forced on for failed tests.
