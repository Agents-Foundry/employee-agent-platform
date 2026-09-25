// Strict parsers for agents-foundry/runtime/v1 and signed manifests. Node consumers only
// (control plane, runtimes); Angular clients import the pure types instead.
import { z } from 'zod';
import {
  artifactRetentionPolicies,
  artifactStorageReferencePattern,
  artifactTypes,
  type ArtifactRegistration,
} from '../../artifacts.js';
import {
  controlPlaneEventTypes,
  runStepKinds,
  runtimeEventTypes,
  type RuntimeCorrelation,
  type RuntimeEventType,
  type TaskSpec,
} from '../../execution.js';
import type {
  AnySignedAgentManifest,
  SignedAgentManifest,
  SignedAgentManifestV2,
} from '../../index.js';
import {
  RUNTIME_PROTOCOL_V1,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeEventPayloads,
} from './protocol.js';
import type {
  RuntimeActionDecision,
  RuntimeActionRequest,
  RuntimeClaimResponse,
} from './transport.js';

/** Upper bound for one serialized event or command. */
export const MAX_RUNTIME_MESSAGE_BYTES = 256 * 1024;

export class RuntimeProtocolError extends Error {
  constructor(
    readonly code:
      | 'PROTOCOL_VERSION_UNSUPPORTED'
      | 'RUNTIME_MESSAGE_TOO_LARGE'
      | 'RUNTIME_EVENT_INVALID'
      | 'RUNTIME_EVENT_TYPE_FORBIDDEN'
      | 'RUNTIME_COMMAND_INVALID'
      | 'RUNTIME_ACTION_INVALID'
      | 'RUNTIME_RESPONSE_INVALID'
      | 'MANIFEST_INVALID',
    readonly issues: readonly string[] = [],
  ) {
    super(code);
  }
}

const recordId = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const shortText = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const errorSchema = z
  .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), message: z.string().max(2000) })
  .strict();
const answers = z.record(
  z.string().max(80),
  z.union([z.string().max(2048), z.array(z.string().max(200)).max(50)]),
);
const capability = z
  .object({ action: z.string().max(120), outcome: z.enum(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']) })
  .strict();
const keySource = z.enum(['EMPLOYEE_BYOK', 'ORGANIZATION_MANAGED']);

export const correlationSchema = z
  .object({
    organizationId: recordId,
    employeeId: recordId,
    agentId: recordId,
    threadId: uuid,
    runId: uuid,
    stepId: uuid.optional(),
    toolCallId: uuid.optional(),
    actionId: uuid.optional(),
  })
  .strict() satisfies z.ZodType<RuntimeCorrelation>;

export const taskSpecSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000),
    workflow: slug.optional(),
    workItem: z
      .object({ system: slug, key: z.string().min(1).max(120), url: z.url().max(2048).optional() })
      .strict()
      .optional(),
    inputs: z
      .record(
        z.string().max(80),
        z.union([
          z.string().max(2048),
          z.number(),
          z.boolean(),
          z.array(z.string().max(200)).max(50),
        ]),
      )
      .refine((value) => Object.keys(value).length <= 50, 'At most 50 inputs.'),
  })
  .strict() satisfies z.ZodType<TaskSpec>;

export const artifactRegistrationSchema = z
  .object({
    id: uuid,
    type: z.enum(artifactTypes),
    mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/i),
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^/\\\0]+$/),
    storageReference: z.string().max(600).regex(artifactStorageReferencePattern),
    checksum: z.object({ algorithm: z.literal('sha256'), value: digest }).strict(),
    sizeBytes: z
      .number()
      .int()
      .min(0)
      .max(5 * 1024 ** 3),
    retentionPolicy: z.enum(artifactRetentionPolicies),
  })
  .strict() satisfies z.ZodType<ArtifactRegistration>;

const payloadSchemas: { [K in RuntimeEventType]: z.ZodType<RuntimeEventPayloads[K]> } = {
  'run.started': z.object({ runtimeSessionId: uuid, kernel: slug }).strict(),
  'run.paused': z.object({ reason: z.literal('APPROVAL_REQUIRED'), actionId: uuid }).strict(),
  'run.resumed': z.object({ approvalId: uuid }).strict(),
  'run.completed': z
    .object({ summary: z.string().max(4000), artifactIds: z.array(uuid).max(200) })
    .strict(),
  'run.failed': z.object({ error: errorSchema, retryable: z.boolean() }).strict(),
  'run.cancelled': z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
  'step.started': z.object({ kind: z.enum(runStepKinds), title: shortText }).strict(),
  'step.completed': z.object({ outputSummary: z.string().max(4000).optional() }).strict(),
  'step.failed': z.object({ error: errorSchema }).strict(),
  'agent.message': z.object({ content: z.string().trim().min(1).max(20_000) }).strict(),
  'agent.reasoning.started': z.object({}).strict() as z.ZodType<Record<string, never>>,
  'model.requested': z.object({ modelProfile: slug, capability: slug }).strict(),
  'model.responded': z
    .object({
      modelProfile: slug,
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      latencyMs: z.number().int().min(0),
      finishReason: z.string().max(40),
    })
    .strict(),
  'tool.requested': z
    .object({ toolCallId: uuid, toolId: slug, toolVersion: semver, inputDigest: digest })
    .strict(),
  'tool.started': z.object({ toolCallId: uuid }).strict(),
  'tool.completed': z
    .object({
      toolCallId: uuid,
      outputDigest: digest,
      durationMs: z.number().int().min(0),
      artifactIds: z.array(uuid).max(200),
    })
    .strict(),
  'tool.failed': z
    .object({ toolCallId: uuid, error: errorSchema, durationMs: z.number().int().min(0) })
    .strict(),
  'artifact.created': z.object({ artifact: artifactRegistrationSchema }).strict(),
};

const envelopeSchema = z
  .object({
    protocol: z.string(),
    eventId: uuid,
    runId: uuid,
    threadId: uuid,
    stepId: uuid.optional(),
    sequence: z.number().int().min(1).max(1_000_000),
    type: z.string(),
    occurredAt: timestamp,
    correlation: correlationSchema,
    payload: z.unknown(),
  })
  .strict();

function messageSize(input: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(input) ?? '').byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** Parse one runtime → control plane event. Throws RuntimeProtocolError; never returns partial data. */
export function parseRuntimeEvent(input: unknown): RuntimeEventEnvelope {
  if (messageSize(input) > MAX_RUNTIME_MESSAGE_BYTES)
    throw new RuntimeProtocolError('RUNTIME_MESSAGE_TOO_LARGE');
  const base = envelopeSchema.safeParse(input);
  if (!base.success) throw new RuntimeProtocolError('RUNTIME_EVENT_INVALID', issues(base.error));
  const envelope = base.data;
  if (envelope.protocol !== RUNTIME_PROTOCOL_V1)
    throw new RuntimeProtocolError('PROTOCOL_VERSION_UNSUPPORTED');
  if ((controlPlaneEventTypes as readonly string[]).includes(envelope.type))
    throw new RuntimeProtocolError('RUNTIME_EVENT_TYPE_FORBIDDEN');
  if (!(runtimeEventTypes as readonly string[]).includes(envelope.type))
    throw new RuntimeProtocolError('RUNTIME_EVENT_INVALID', [`type: unknown ${envelope.type}`]);
  const type = envelope.type as RuntimeEventType;
  const payload = payloadSchemas[type].safeParse(envelope.payload);
  if (!payload.success)
    throw new RuntimeProtocolError('RUNTIME_EVENT_INVALID', issues(payload.error));
  const problems: string[] = [];
  if (type.startsWith('step.') && !envelope.stepId)
    problems.push('stepId: required for step events');
  if (envelope.correlation.runId !== envelope.runId) problems.push('correlation.runId: mismatch');
  if (envelope.correlation.threadId !== envelope.threadId)
    problems.push('correlation.threadId: mismatch');
  if (envelope.correlation.stepId && envelope.correlation.stepId !== envelope.stepId)
    problems.push('correlation.stepId: mismatch');
  if (problems.length) throw new RuntimeProtocolError('RUNTIME_EVENT_INVALID', problems);
  return {
    ...envelope,
    protocol: RUNTIME_PROTOCOL_V1,
    type,
    payload: payload.data,
  } as RuntimeEventEnvelope;
}

const manifestV1Schema = z
  .object({
    apiVersion: z.literal('agents-foundry/v1'),
    manifestId: uuid,
    agentId: recordId,
    organizationId: recordId,
    employeeId: recordId,
    blueprint: z.object({ id: z.string().max(120), version: semver }).strict(),
    model: z
      .object({
        provider: z.string().max(80),
        model: z.string().max(160),
        credentialMode: keySource,
      })
      .strict(),
    answers,
    capabilities: z.array(capability).max(100),
    conversationSync: z.literal('REQUIRED'),
    policyVersion: z.string().max(80),
    issuedAt: timestamp,
  })
  .strict();

const versionedReference = z.object({ id: slug, version: semver }).strict();

export const manifestV2PayloadSchema = z
  .object({
    apiVersion: z.literal('agents-foundry/v2'),
    kind: z.literal('AgentManifest'),
    metadata: z
      .object({
        manifestId: uuid,
        agentId: recordId,
        organizationId: recordId,
        employeeId: recordId,
        issuedAt: timestamp,
        blueprint: z
          .object({ id: z.string().max(120), version: semver, digest: digest.optional() })
          .strict(),
        installationId: uuid.optional(),
      })
      .strict(),
    identity: z.object({ name: shortText, role: slug, department: shortText }).strict(),
    persona: z.object({ profile: slug }).strict(),
    runtime: z.object({ profile: slug, isolation: z.enum(['sandboxed', 'local']) }).strict(),
    model: z
      .object({
        profile: slug,
        provider: z.string().max(80),
        model: z.string().max(160),
        credentialMode: keySource,
      })
      .strict(),
    skills: z.array(versionedReference).max(100),
    tools: z.array(slug).max(100),
    connectors: z
      .array(z.object({ id: slug, capabilities: z.array(z.string().max(120)).max(50) }).strict())
      .max(50),
    mcp: z.array(slug).max(50),
    memory: z.object({ profile: slug }).strict(),
    knowledge: z.object({ sources: z.array(slug).max(50) }).strict(),
    policies: z
      .object({
        profile: slug,
        policyVersion: z.string().max(80),
        capabilities: z.array(capability).max(100),
      })
      .strict(),
    workflows: z.array(slug).max(100),
    evaluations: z.object({ suite: slug }).strict(),
    configuration: answers,
    conversationSync: z.literal('REQUIRED'),
  })
  .strict();

const signature = {
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .max(200),
  algorithm: z.literal('Ed25519'),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
};
export const signedManifestV2Schema = z
  .object({ payload: manifestV2PayloadSchema, ...signature })
  .strict() satisfies z.ZodType<SignedAgentManifestV2>;
const signedManifestV1Schema = z
  .object({ payload: manifestV1Schema, ...signature })
  .strict() satisfies z.ZodType<SignedAgentManifest>;

/**
 * Structural validation of a stored or received signed manifest. Signature verification is
 * separate; both must pass. Unknown `apiVersion` values fail closed.
 */
export function parseSignedManifest(input: unknown): AnySignedAgentManifest {
  const version = (input as { payload?: { apiVersion?: unknown } } | null)?.payload?.apiVersion;
  const schema =
    version === 'agents-foundry/v2'
      ? signedManifestV2Schema
      : version === 'agents-foundry/v1'
        ? signedManifestV1Schema
        : undefined;
  if (!schema)
    throw new RuntimeProtocolError('MANIFEST_INVALID', ['payload.apiVersion: unsupported']);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new RuntimeProtocolError('MANIFEST_INVALID', issues(parsed.error));
  return input as AnySignedAgentManifest;
}

const commandBase = {
  protocol: z.literal(RUNTIME_PROTOCOL_V1),
  commandId: uuid,
  issuedAt: timestamp,
  correlation: correlationSchema,
};
const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...commandBase,
      type: z.literal('run.submit'),
      run: z
        .object({
          runId: uuid,
          threadId: uuid,
          task: taskSpecSchema,
          runtimeProfile: slug,
          manifest: signedManifestV2Schema,
          workspace: z
            .object({ workspaceId: uuid, persistence: z.enum(['EPHEMERAL', 'PERSISTENT']) })
            .strict()
            .nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('run.resume'),
      runId: uuid,
      approval: z
        .object({
          approvalId: uuid,
          decision: z.enum(['APPROVED', 'REJECTED']),
          decidedAt: timestamp,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('run.cancel'),
      runId: uuid,
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

/** Parse one control plane → runtime command (used by runtimes and by control-plane tests). */
export function parseRuntimeCommand(input: unknown): RuntimeCommand {
  if (messageSize(input) > MAX_RUNTIME_MESSAGE_BYTES)
    throw new RuntimeProtocolError('RUNTIME_MESSAGE_TOO_LARGE');
  const version = (input as { protocol?: unknown } | null)?.protocol;
  if (version !== RUNTIME_PROTOCOL_V1)
    throw new RuntimeProtocolError('PROTOCOL_VERSION_UNSUPPORTED');
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success)
    throw new RuntimeProtocolError('RUNTIME_COMMAND_INVALID', issues(parsed.error));
  const command = parsed.data as RuntimeCommand;
  const runId = command.type === 'run.submit' ? command.run.runId : command.runId;
  if (command.correlation.runId !== runId)
    throw new RuntimeProtocolError('RUNTIME_COMMAND_INVALID', ['correlation.runId: mismatch']);
  if (
    command.type === 'run.submit' &&
    (command.correlation.threadId !== command.run.threadId ||
      command.run.manifest.payload.metadata.agentId !== command.correlation.agentId ||
      command.run.manifest.payload.metadata.employeeId !== command.correlation.employeeId ||
      command.run.manifest.payload.metadata.organizationId !== command.correlation.organizationId)
  )
    throw new RuntimeProtocolError('RUNTIME_COMMAND_INVALID', ['correlation: manifest mismatch']);
  return command;
}

const actionName = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/);
const risk = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const actionRequestSchema = z
  .object({
    protocol: z.literal(RUNTIME_PROTOCOL_V1),
    requestId: uuid,
    correlation: correlationSchema.extend({ stepId: uuid, toolCallId: uuid }).strict(),
    action: actionName,
    toolId: slug,
    toolVersion: semver,
    inputDigest: digest,
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

/** Parse a runtime's governed-action request (transport, ADR 0011). */
export function parseRuntimeActionRequest(input: unknown): RuntimeActionRequest {
  if (messageSize(input) > MAX_RUNTIME_MESSAGE_BYTES)
    throw new RuntimeProtocolError('RUNTIME_MESSAGE_TOO_LARGE');
  if ((input as { protocol?: unknown } | null)?.protocol !== RUNTIME_PROTOCOL_V1)
    throw new RuntimeProtocolError('PROTOCOL_VERSION_UNSUPPORTED');
  const parsed = actionRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new RuntimeProtocolError('RUNTIME_ACTION_INVALID', issues(parsed.error));
  return parsed.data;
}

const decisionBase = { requestId: uuid, risk, reason: z.string().max(500) };
const actionDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ ...decisionBase, decision: z.literal('ALLOWED') }).strict(),
  z.object({ ...decisionBase, decision: z.literal('DENIED') }).strict(),
  z
    .object({ ...decisionBase, decision: z.literal('APPROVAL_REQUIRED'), approvalId: uuid })
    .strict(),
]);

/** Runtime-side validation of a control-plane action decision; anything malformed is a denial. */
export function parseRuntimeActionDecision(input: unknown): RuntimeActionDecision {
  const parsed = actionDecisionSchema.safeParse(input);
  if (!parsed.success)
    throw new RuntimeProtocolError('RUNTIME_RESPONSE_INVALID', issues(parsed.error));
  return parsed.data;
}

const claimResponseSchema = z
  .object({
    command: z.unknown(),
    lease: z
      .object({
        sessionId: uuid,
        runtimeSequence: z.number().int().min(0).max(1_000_000),
        leaseExpiresAt: timestamp,
      })
      .strict(),
  })
  .strict();

/** Runtime-side validation of a claim response; the command is parsed strictly as well. */
export function parseRuntimeClaimResponse(input: unknown): RuntimeClaimResponse {
  const parsed = claimResponseSchema.safeParse(input);
  if (!parsed.success)
    throw new RuntimeProtocolError('RUNTIME_RESPONSE_INVALID', issues(parsed.error));
  return { command: parseRuntimeCommand(parsed.data.command), lease: parsed.data.lease };
}
