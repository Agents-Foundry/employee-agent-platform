import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  RunCheckpointBinding,
  RuntimeCheckpointLoadRequest,
  RuntimeCheckpointRecord,
  RuntimeCheckpointSaveRequest,
  RuntimeCheckpointAck,
  RuntimeCorrelation,
  SignedAgentManifestV2,
  TaskSpec,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import { workflowDefinitionSchema } from '../../../packages/contracts/src/catalog-schemas.js';
import { canonicalManifest } from '../../../packages/contracts/src/manifest.js';
import { RUNTIME_PROTOCOL_V1 } from '../../../packages/contracts/src/runtime/v1/protocol.js';
import {
  correlationSchema,
  signedManifestV2Schema,
  taskSpecSchema,
} from '../../../packages/contracts/src/runtime/v1/schemas.js';
import { ControlPlaneError } from './errors.js';

/**
 * Everything needed to continue a run in any runtime that is given it (ADR 0032). Contains
 * conversation content. Never contains a credential: the host refuses to save one.
 */
export interface RunCheckpoint {
  format: 2;
  /** Position in the run's checkpoint history: each save is exactly one more than the last. */
  version: number;
  runId: string;
  /** The lease session that wrote it. */
  sessionId: string;
  correlation: RuntimeCorrelation;
  task: TaskSpec;
  workflow?: WorkflowDefinition;
  runtimeProfile: string;
  manifest: SignedAgentManifestV2;
  kernelId: string;
  kernelState: unknown;
  /** The step in progress, if any. */
  stepId: string | null;
  /** The approval the run is paused for, if any. */
  approvalId: string | null;
  /** The last runtime event sequence emitted before the checkpoint. */
  runtimeSequence: number;
}

/** Another runtime advanced the run, or this one no longer holds it. Stop working on it. */
export class CheckpointConflict extends Error {
  constructor() {
    super('CHECKPOINT_CONFLICT');
  }
}

/** The stored checkpoint cannot be trusted: unreadable, altered or bound to something else. */
export class CheckpointInvalid extends Error {
  constructor() {
    super('RUNTIME_CHECKPOINT_INVALID');
  }
}

export interface CheckpointStore {
  /** Refuses (`CheckpointConflict`) any version that is not exactly the next one. */
  save(checkpoint: RunCheckpoint): Promise<void>;
  /** The latest checkpoint, verified, or null. Throws `CheckpointInvalid` if it is corrupt. */
  load(correlation: RuntimeCorrelation): Promise<RunCheckpoint | null>;
  /** Forget the run. Durable stores leave this to the control plane. */
  delete(runId: string): Promise<void>;
}

const uuid = z.uuid();
const checkpointSchema = z
  .object({
    format: z.literal(2),
    version: z.number().int().min(1).max(1_000_000),
    runId: uuid,
    sessionId: uuid,
    correlation: correlationSchema,
    task: taskSpecSchema,
    workflow: workflowDefinitionSchema.optional(),
    runtimeProfile: z.string().min(1).max(100),
    manifest: signedManifestV2Schema,
    kernelId: z.string().min(1).max(100),
    kernelState: z.unknown(),
    stepId: uuid.nullable(),
    approvalId: uuid.nullable(),
    runtimeSequence: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function manifestDigest(manifest: SignedAgentManifestV2): string {
  return sha256(canonicalManifest(manifest.payload));
}

export function checkpointBinding(checkpoint: RunCheckpoint): RunCheckpointBinding {
  return {
    manifestId: checkpoint.manifest.payload.metadata.manifestId,
    manifestDigest: manifestDigest(checkpoint.manifest),
    workflow: checkpoint.task.workflow ?? null,
    stepId: checkpoint.stepId,
    approvalId: checkpoint.approvalId,
    kernelId: checkpoint.kernelId,
    runtimeSequence: checkpoint.runtimeSequence,
  };
}

/** Parses a stored body and checks it belongs to the run it was asked for. Fails closed. */
export function parseCheckpoint(body: string, correlation: RuntimeCorrelation): RunCheckpoint {
  let parsed;
  try {
    parsed = checkpointSchema.safeParse(JSON.parse(body));
  } catch {
    throw new CheckpointInvalid();
  }
  if (!parsed.success) throw new CheckpointInvalid();
  const checkpoint = parsed.data as RunCheckpoint;
  const own = checkpoint.correlation;
  if (
    checkpoint.runId !== correlation.runId ||
    own.runId !== correlation.runId ||
    own.organizationId !== correlation.organizationId ||
    own.threadId !== correlation.threadId ||
    own.employeeId !== correlation.employeeId ||
    own.agentId !== correlation.agentId
  )
    throw new CheckpointInvalid();
  return checkpoint;
}

interface Envelope {
  sha256: string;
  body: string;
}

function open(envelope: Envelope, correlation: RuntimeCorrelation): RunCheckpoint {
  if (typeof envelope?.body !== 'string' || sha256(envelope.body) !== envelope.sha256)
    throw new CheckpointInvalid();
  return parseCheckpoint(envelope.body, correlation);
}

const runIdPattern = /^[0-9a-f-]{36}$/;

/**
 * Local development adapter: one JSON file per run, owner-readable only, written atomically.
 * A run checkpointed here can only continue on this host.
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

  private async read(runId: string): Promise<Envelope | null> {
    try {
      return JSON.parse(await readFile(this.path(runId), 'utf8')) as Envelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new CheckpointInvalid();
      throw error;
    }
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const existing = await this.read(checkpoint.runId);
    const current = existing ? open(existing, checkpoint.correlation).version : 0;
    if (checkpoint.version !== current + 1) throw new CheckpointConflict();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(checkpoint.runId);
    const temporary = `${path}.${process.pid}.tmp`;
    const body = JSON.stringify(checkpoint);
    await writeFile(temporary, JSON.stringify({ sha256: sha256(body), body }), { mode: 0o600 });
    await rename(temporary, path);
  }

  async load(correlation: RuntimeCorrelation): Promise<RunCheckpoint | null> {
    const envelope = await this.read(correlation.runId);
    return envelope ? open(envelope, correlation) : null;
  }

  async delete(runId: string): Promise<void> {
    await rm(this.path(runId), { force: true });
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  readonly items = new Map<string, Envelope>();

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const existing = this.items.get(checkpoint.runId);
    const current = existing ? open(existing, checkpoint.correlation).version : 0;
    if (checkpoint.version !== current + 1) throw new CheckpointConflict();
    const body = JSON.stringify(checkpoint);
    this.items.set(checkpoint.runId, { sha256: sha256(body), body });
  }

  async load(correlation: RuntimeCorrelation): Promise<RunCheckpoint | null> {
    const envelope = this.items.get(correlation.runId);
    return envelope ? open(envelope, correlation) : null;
  }

  async delete(runId: string): Promise<void> {
    this.items.delete(runId);
  }
}

/** The part of the control plane transport the durable store needs. */
export interface CheckpointTransport {
  saveCheckpoint(request: RuntimeCheckpointSaveRequest): Promise<RuntimeCheckpointAck>;
  loadCheckpoint(request: RuntimeCheckpointLoadRequest): Promise<RuntimeCheckpointRecord | null>;
}

const CONFLICTS = new Set([
  'CHECKPOINT_VERSION_CONFLICT',
  'CHECKPOINT_SESSION_STALE',
  'RUNTIME_LEASE_REQUIRED',
  'RUN_TERMINAL',
  'RUN_NOT_RUNNING',
]);

/**
 * Durable adapter: checkpoints are kept by the control plane, through the runtime's signed
 * transport, so any authorized runtime that is given the run can continue it. The control
 * plane enforces the version order and the lease session, and deletes them when the run ends.
 */
export class ControlPlaneCheckpointStore implements CheckpointStore {
  constructor(private readonly transport: CheckpointTransport) {}

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const body = JSON.stringify(checkpoint);
    try {
      await this.transport.saveCheckpoint({
        protocol: RUNTIME_PROTOCOL_V1,
        correlation: checkpoint.correlation,
        sessionId: checkpoint.sessionId,
        version: checkpoint.version,
        binding: checkpointBinding(checkpoint),
        sha256: sha256(body),
        body,
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && CONFLICTS.has(error.code))
        throw new CheckpointConflict();
      throw error;
    }
  }

  async load(correlation: RuntimeCorrelation): Promise<RunCheckpoint | null> {
    let record: RuntimeCheckpointRecord | null;
    try {
      record = await this.transport.loadCheckpoint({ protocol: RUNTIME_PROTOCOL_V1, correlation });
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        ['CHECKPOINT_CORRUPT', 'CHECKPOINT_BINDING_MISMATCH'].includes(error.code)
      )
        throw new CheckpointInvalid();
      throw error;
    }
    if (!record) return null;
    const checkpoint = open(record, correlation);
    // What the control plane says it stored must be what the body says.
    const binding = checkpointBinding(checkpoint);
    if (
      record.runId !== checkpoint.runId ||
      record.version !== checkpoint.version ||
      (Object.keys(binding) as (keyof RunCheckpointBinding)[]).some(
        (key) => binding[key] !== record.binding[key],
      )
    )
      throw new CheckpointInvalid();
    return checkpoint;
  }

  async delete(): Promise<void> {
    // The control plane owns the lifecycle: another runtime may be continuing the run.
  }
}
