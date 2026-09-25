import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  RuntimeCorrelation,
  SignedAgentManifestV2,
  TaskSpec,
} from '@agents-foundry/contracts';

/** Everything needed to resume a paused run in this runtime. Contains conversation content. */
export interface RunCheckpoint {
  version: 1;
  runId: string;
  sessionId: string;
  correlation: RuntimeCorrelation;
  task: TaskSpec;
  runtimeProfile: string;
  manifest: SignedAgentManifestV2;
  kernelId: string;
  kernelState: unknown;
  approvalId: string;
}

export interface CheckpointStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(runId: string): Promise<RunCheckpoint | null>;
  delete(runId: string): Promise<void>;
}

const runIdPattern = /^[0-9a-f-]{36}$/;

/**
 * One JSON file per paused run, owner-readable only, written atomically. Checkpoints stay on
 * the runtime host; they are never sent to the control plane or the browser.
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(runId: string): string {
    if (!runIdPattern.test(runId)) throw new Error('RUN_ID_INVALID');
    return join(this.root, `${runId}.json`);
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(checkpoint.runId);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
    await rename(temporary, path);
  }

  async load(runId: string): Promise<RunCheckpoint | null> {
    try {
      return JSON.parse(await readFile(this.path(runId), 'utf8')) as RunCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(runId: string): Promise<void> {
    await rm(this.path(runId), { force: true });
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  readonly items = new Map<string, string>();

  async save(checkpoint: RunCheckpoint): Promise<void> {
    this.items.set(checkpoint.runId, JSON.stringify(checkpoint));
  }

  async load(runId: string): Promise<RunCheckpoint | null> {
    const item = this.items.get(runId);
    return item ? (JSON.parse(item) as RunCheckpoint) : null;
  }

  async delete(runId: string): Promise<void> {
    this.items.delete(runId);
  }
}
