// Strict parsers for agents-foundry/execution/v1. Node consumers only.
import { z } from 'zod';
import { artifactRegistrationSchema } from '../../runtime/v1/schemas.js';
import type { ExecutionOperation } from '../../execution.js';
import {
  EXECUTION_GRANT_KIND,
  EXECUTION_PROTOCOL_V1,
  type ExecuteOperationRequest,
  type ExecuteOperationResponse,
  type SignedExecutionGrant,
} from './protocol.js';

export class ExecutionProtocolError extends Error {
  constructor(
    readonly code:
      | 'EXECUTION_OPERATION_INVALID'
      | 'EXECUTION_GRANT_INVALID'
      | 'EXECUTION_REQUEST_INVALID'
      | 'EXECUTION_RESPONSE_INVALID',
    readonly issues: readonly string[] = [],
  ) {
    super(code);
  }
}

const uuid = z.uuid();
const recordId = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const timestamp = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);

/**
 * Workspace-relative path: `.` or `/`-separated segments of safe characters. No absolute
 * paths, drive letters, backslashes, `..` or empty segments, so no path can name anything
 * outside the workspace before the provider even resolves it.
 */
export const workspacePathSchema = z
  .string()
  .max(512)
  .regex(/^(\.|[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*)$/)
  .refine((value) => !value.split('/').some((segment) => segment === '..' || segment === '.git'), {
    message: 'path must stay inside the workspace and outside .git',
  });

/** Branch or tag names only; no options, ranges, reflog syntax or `..`. */
const gitRef = z
  .string()
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}$/)
  .refine((value) => !value.endsWith('.lock') && !value.endsWith('/'), 'invalid ref');

const url = (protocols: string[]) =>
  z
    .url()
    .max(2048)
    .refine(
      (value) => {
        const parsed = new URL(value);
        return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password;
      },
      `must be ${protocols.join(' or ')} without credentials`,
    );

export const executionOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('git.checkout'),
      repositoryUrl: url(['https:', 'file:']),
      ref: gitRef,
      path: workspacePathSchema.refine((value) => value !== '.', 'checkout needs a subdirectory'),
    })
    .strict(),
  z.object({ kind: z.literal('git.status'), path: workspacePathSchema }).strict(),
  z.object({ kind: z.literal('file.read'), path: workspacePathSchema }).strict(),
  z
    .object({
      kind: z.literal('file.write'),
      path: workspacePathSchema,
      contentArtifactId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal('command'),
      command: slug,
      args: z.array(z.string().max(1000)).max(50),
      cwd: workspacePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('playwright.run'),
      project: slug,
      baseUrl: url(['https:', 'http:']),
      path: workspacePathSchema.optional(),
    })
    .strict(),
]) satisfies z.ZodType<ExecutionOperation>;

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export function parseExecutionOperation(input: unknown): ExecutionOperation {
  const parsed = executionOperationSchema.safeParse(input);
  if (!parsed.success)
    throw new ExecutionProtocolError('EXECUTION_OPERATION_INVALID', issues(parsed.error));
  return parsed.data;
}

const limitsSchema = z
  .object({
    timeoutMs: z.number().int().min(1000).max(3_600_000),
    cpuMillis: z.number().int().min(1).max(64_000),
    memoryMb: z.number().int().min(64).max(65_536),
    maxProcesses: z.number().int().min(1).max(1024),
    network: z
      .object({
        mode: z.enum(['NONE', 'ALLOW_LIST']),
        allowedHosts: z.array(z.string().max(253)).max(20),
      })
      .strict(),
  })
  .strict();

export const signedExecutionGrantSchema = z
  .object({
    payload: z
      .object({
        kind: z.literal(EXECUTION_GRANT_KIND),
        grantId: uuid,
        requestId: uuid,
        action: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/),
        correlation: z
          .object({
            organizationId: recordId,
            employeeId: recordId,
            agentId: recordId,
            threadId: uuid,
            runId: uuid,
            stepId: uuid,
            toolCallId: uuid,
          })
          .strict(),
        operationKind: z.enum([
          'git.checkout',
          'git.status',
          'file.read',
          'file.write',
          'command',
          'playwright.run',
        ]),
        operationDigest: digest,
        isolation: z.enum(['sandboxed', 'local']),
        limits: limitsSchema,
        issuedAt: timestamp,
        expiresAt: timestamp,
      })
      .strict(),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(200),
    algorithm: z.literal('Ed25519'),
    keyId: digest,
  })
  .strict() satisfies z.ZodType<SignedExecutionGrant>;

export function parseSignedExecutionGrant(input: unknown): SignedExecutionGrant {
  const parsed = signedExecutionGrantSchema.safeParse(input);
  if (!parsed.success)
    throw new ExecutionProtocolError('EXECUTION_GRANT_INVALID', issues(parsed.error));
  return parsed.data;
}

const requestSchema = z
  .object({
    protocol: z.literal(EXECUTION_PROTOCOL_V1),
    grant: z.unknown(),
    operation: z.unknown(),
  })
  .strict();

export function parseExecuteOperationRequest(input: unknown): ExecuteOperationRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw new ExecutionProtocolError('EXECUTION_REQUEST_INVALID', issues(parsed.error));
  return {
    protocol: EXECUTION_PROTOCOL_V1,
    grant: parseSignedExecutionGrant(parsed.data.grant),
    operation: parseExecutionOperation(parsed.data.operation),
  };
}

const errorSchema = z
  .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), message: z.string().max(2000) })
  .strict();
const responseSchema = z
  .object({
    result: z
      .object({
        requestId: z.string().max(120),
        status: z.enum(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'DENIED']),
        exitCode: z.number().int().optional(),
        artifactIds: z.array(uuid).max(50),
        durationMs: z.number().int().min(0),
        error: errorSchema.optional(),
      })
      .strict(),
    workspace: z
      .object({
        id: uuid,
        state: z.enum(['PROVISIONING', 'READY', 'IN_USE', 'SUSPENDED', 'LOST', 'DESTROYED']),
      })
      .strict(),
    output: z.string().max(300_000),
    truncated: z.boolean(),
    artifacts: z.array(artifactRegistrationSchema).max(50),
  })
  .strict();

export function parseExecuteOperationResponse(input: unknown): ExecuteOperationResponse {
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success)
    throw new ExecutionProtocolError('EXECUTION_RESPONSE_INVALID', issues(parsed.error));
  return parsed.data;
}
