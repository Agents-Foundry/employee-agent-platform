import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const segment = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * Evidence store for execution output. References are opaque
 * `artifact://<store>/<org>/<run>/<artifact>/<name>` keys; host paths never leave the runtime.
 */
export class ExecutionArtifactStore {
  private readonly root: string;

  constructor(
    root: string,
    readonly storeName = 'execution-local',
  ) {
    this.root = resolve(root);
  }

  async put(input: {
    organizationId: string;
    runId: string;
    artifactId: string;
    name: string;
    content: Buffer;
  }): Promise<{ storageReference: string; checksum: string; sizeBytes: number }> {
    const parts = [input.organizationId, input.runId, input.artifactId, input.name];
    if (!parts.every((part) => segment.test(part) && !part.includes('..')))
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
