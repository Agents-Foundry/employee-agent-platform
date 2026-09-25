import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface StoredArtifact {
  storageReference: string;
  checksum: string;
  sizeBytes: number;
}

export interface ArtifactStore {
  put(input: {
    organizationId: string;
    runId: string;
    artifactId: string;
    name: string;
    content: Buffer;
  }): Promise<StoredArtifact>;
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

  async put(input: {
    organizationId: string;
    runId: string;
    artifactId: string;
    name: string;
    content: Buffer;
  }): Promise<StoredArtifact> {
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

  async put(input: {
    organizationId: string;
    runId: string;
    artifactId: string;
    name: string;
    content: Buffer;
  }): Promise<StoredArtifact> {
    const key = [input.organizationId, input.runId, input.artifactId, input.name].join('/');
    this.items.set(key, input.content);
    return {
      storageReference: `artifact://memory/${key}`,
      checksum: createHash('sha256').update(input.content).digest('hex'),
      sizeBytes: input.content.byteLength,
    };
  }
}
