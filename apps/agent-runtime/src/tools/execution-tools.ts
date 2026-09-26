import type { ExecutionOperation } from '@agents-foundry/contracts';
import { parseExecutionOperation } from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import { RuntimeFailure } from '../errors.js';
import type { ExecutionPort } from '../transport/execution-client.js';
import type { RuntimeTool, ToolExecutionContext, ToolOutput } from './runtime-tool.js';

/**
 * Shared shape of tools whose work happens in an execution runtime (ADR 0013). The tool input
 * is the operation itself, so the approved digest, the grant and the executed operation are
 * one and the same object.
 */
abstract class ExecutionTool implements RuntimeTool<ExecutionOperation> {
  abstract readonly id: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;
  protected abstract readonly action: string;
  protected abstract readonly kinds: readonly ExecutionOperation['kind'][];
  readonly version = '1.0.0';
  readonly sendsParameters = true;

  constructor(private readonly execution: ExecutionPort) {}

  parse(input: unknown): ExecutionOperation {
    const operation = parseExecutionOperation(input);
    if (!this.kinds.includes(operation.kind))
      throw new RuntimeFailure('OPERATION_NOT_ALLOWED', `${this.id} cannot run ${operation.kind}.`);
    return operation;
  }

  governedAction(): string {
    return this.action;
  }

  abstract summarize(input: ExecutionOperation): string;

  async execute(input: ExecutionOperation, context: ToolExecutionContext): Promise<ToolOutput> {
    if (!context.governedAction)
      throw new RuntimeFailure('ACTION_NOT_AUTHORIZED', 'The operation was not authorized.');
    const grant = await context.governedAction.grant();
    const response = await this.execution.execute(grant, input);
    for (const artifact of response.artifacts) await context.registerArtifact(artifact);
    const artifactIds = response.artifacts.map((artifact) => artifact.id);
    if (response.result.status !== 'SUCCEEDED') {
      const error = response.result.error ?? { code: 'EXECUTION_FAILED', message: 'Failed.' };
      const detail = response.output ? `\n${response.output.slice(0, 4000)}` : '';
      throw new RuntimeFailure(error.code, `${error.message}${detail}`);
    }
    return {
      output: response.truncated ? `${response.output}\n[output truncated]` : response.output,
      artifactIds,
    };
  }
}

/** Catalog tool `repository@1.0.0`: check out, inspect and read assigned repositories. */
export class RepositoryTool extends ExecutionTool {
  readonly id = 'repository';
  protected readonly action = 'repository.read';
  protected readonly kinds = ['git.checkout', 'git.status', 'file.read'] as const;
  readonly description =
    'Work with the assigned repository in your isolated workspace: check out a branch ' +
    '(git.checkout), show changes (git.status) or read a text file (file.read). Paths are ' +
    'relative to the workspace. Only the configured repository can be checked out.';
  readonly inputSchema = {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'repositoryUrl', 'ref', 'path'],
        properties: {
          kind: { const: 'git.checkout' },
          repositoryUrl: { type: 'string' },
          ref: { type: 'string', description: 'Branch or tag name.' },
          path: { type: 'string', description: 'Workspace subdirectory, for example "repo".' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'path'],
        properties: {
          kind: { enum: ['git.status', 'file.read'] },
          path: { type: 'string' },
        },
      },
    ],
  };

  summarize(input: ExecutionOperation): string {
    return input.kind === 'git.checkout'
      ? `Check out ${input.ref} of ${input.repositoryUrl}`
      : `${input.kind} ${'path' in input ? input.path : ''}`;
  }
}

/** Catalog tool `browser@1.0.0`: run the project's Playwright tests against the QA environment. */
export class BrowserTool extends ExecutionTool {
  readonly id = 'browser';
  protected readonly action = 'qa.execute_playwright';
  protected readonly kinds = ['playwright.run'] as const;
  readonly description =
    "Run the checked-out project's Playwright tests (playwright.run) against the configured QA " +
    'environment. Requires approval. Results are stored as a test report.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'project', 'baseUrl'],
    properties: {
      kind: { const: 'playwright.run' },
      project: { type: 'string', description: 'Playwright project name, for example "chromium".' },
      baseUrl: { type: 'string', description: 'URL inside the configured QA environment.' },
      path: {
        type: 'string',
        description: 'Workspace directory of the project, for example "repo".',
      },
    },
  };

  summarize(input: ExecutionOperation): string {
    return input.kind === 'playwright.run'
      ? `Run Playwright ${input.project} against ${input.baseUrl}`
      : 'Run Playwright';
  }
}
