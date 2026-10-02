import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type {
  ArtifactRetentionPolicy,
  ArtifactUpload,
  RuntimeArtifactUploadRequest,
  RuntimeCorrelation,
} from '@agents-foundry/contracts';
import { RUNTIME_PROTOCOL_V1 } from '../../../../packages/contracts/src/runtime/v1/protocol.js';

export interface StoredArtifact {
  storageReference: string;
  checksum: string;
  sizeBytes: number;
}

export interface ArtifactInput {
  organizationId: string;
  runId: string;
  artifactId: string;
  name: string;
  content: Buffer;
  /** The tool call that produced it, its media type and retention; durable stores need them. */
  correlation?: RuntimeCorrelation & { stepId: string; toolCallId?: string };
  mediaType?: string;
  retentionPolicy?: ArtifactRetentionPolicy;
}

export interface ArtifactStore {
  put(input: ArtifactInput): Promise<StoredArtifact>;
}

/** The part of the control plane transport the durable store needs. */
export interface ArtifactTransport {
  uploadArtifact(request: RuntimeArtifactUploadRequest): Promise<ArtifactUpload>;
}

/**
 * Durable adapter (ADR 0033): the bytes go to the control plane's artifact store through the
 * runtime's signed transport, for a running step of a run this runtime holds. The runtime
 * never holds object-store credentials, and nothing is kept on its own disk.
 */
export class ControlPlaneArtifactStore implements ArtifactStore {
  constructor(private readonly transport: ArtifactTransport) {}

  async put(input: ArtifactInput): Promise<StoredArtifact> {
    if (!input.correlation || !input.mediaType) throw new Error('ARTIFACT_CORRELATION_REQUIRED');
    const checksum = createHash('sha256').update(input.content).digest('hex');
    const stored = await this.transport.uploadArtifact({
      protocol: RUNTIME_PROTOCOL_V1,
      correlation: input.correlation,
      artifact: {
        id: input.artifactId,
        mediaType: input.mediaType,
        name: input.name,
        checksum: { algorithm: 'sha256', value: checksum },
        sizeBytes: input.content.byteLength,
        retentionPolicy: input.retentionPolicy ?? 'STANDARD_30D',
      },
      content: input.content.toString('base64'),
    });
    // What was stored must be what was sent.
    if (
      stored.artifactId !== input.artifactId ||
      stored.checksum.value !== checksum ||
      stored.sizeBytes !== input.content.byteLength
    )
      throw new Error('ARTIFACT_UPLOAD_MISMATCH');
    return {
      storageReference: stored.storageReference,
      checksum,
      sizeBytes: input.content.byteLength,
    };
  }
}

const segment = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * Filesystem artifact store for a single runtime host. References are opaque
 * `artifact://<store>/<org>/<run>/<artifact>/<name>` keys; local paths never leave the runtime.
 */
export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(
    root: string,
    private readonly storeName = 'local-runtime',
  ) {
    this.root = resolve(root);
  }

  async put(input: ArtifactInput): Promise<StoredArtifact> {
    const parts = [input.organizationId, input.runId, input.artifactId, input.name];
    if (!parts.every((part) => segment.test(part) && part !== '.' && !part.includes('..')))
      throw new Error('ARTIFACT_KEY_INVALID');
    const directory = join(this.root, ...parts.slice(0, 3));
    const path = join(directory, input.name);
    if (!path.startsWith(this.root + sep)) throw new Error('ARTIFACT_KEY_INVALID');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, input.content, { flag: 'wx', mode: 0o600 });
    return {
      storageReference: `artifact://${this.storeName}/${parts.join('/')}`,
      checksum: createHash('sha256').update(input.content).digest('hex'),
      sizeBytes: input.content.byteLength,
    };
  }
}

/** Keeps artifacts in memory (tests). */
export class MemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, Buffer>();

  async put(input: ArtifactInput): Promise<StoredArtifact> {
    const key = [input.organizationId, input.runId, input.artifactId, input.name].join('/');
    this.items.set(key, input.content);
    return {
      storageReference: `artifact://memory/${key}`,
      checksum: createHash('sha256').update(input.content).digest('hex'),
      sizeBytes: input.content.byteLength,
    };
  }
}
