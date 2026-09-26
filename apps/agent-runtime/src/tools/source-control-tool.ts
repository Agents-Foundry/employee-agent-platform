import { z } from 'zod';
import { RuntimeFailure } from '../errors.js';
import type { RuntimeTool, ToolExecutionContext, ToolOutput } from './runtime-tool.js';

const inputSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
    baseBranch: z.string().min(1).max(200),
    headBranch: z.string().regex(/^agents-foundry\/[a-z0-9][a-z0-9._-]{0,79}$/),
    title: z
      .string()
      .max(200)
      .refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value), 'one non-blank line'),
    body: z.string().max(20_000),
    path: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/),
  })
  .strict();
type PullRequestInput = z.infer<typeof inputSchema>;

/**
 * Catalog tool `source-control@1.0.0`: propose the workspace changes as a draft pull request
 * (ADR 0015). The runtime sends only the request; the control plane assembles the change set
 * from the file writes it recorded, asks for approval, and calls the source-control connector.
 */
export class SourceControlTool implements RuntimeTool<PullRequestInput> {
  readonly id = 'source-control';
  readonly version = '1.0.0';
  readonly sendsParameters = true;
  readonly description =
    'Propose every file you wrote under a workspace directory as a draft pull request. The ' +
    'platform collects the files itself; a human must approve before anything is published. ' +
    'The head branch must be new and start with "agents-foundry/".';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['repository', 'baseBranch', 'headBranch', 'title', 'body', 'path'],
    properties: {
      repository: { type: 'string', description: 'owner/name of the configured repository.' },
      baseBranch: { type: 'string', description: 'Branch to merge into, for example "main".' },
      headBranch: {
        type: 'string',
        description: 'New branch, for example "agents-foundry/ui-12".',
      },
      title: { type: 'string', description: 'One-line pull request title.' },
      body: { type: 'string', description: 'What changed, why, and how it was verified.' },
      path: {
        type: 'string',
        description: 'Workspace directory of the checkout, for example "repo".',
      },
    },
  };

  parse(input: unknown): PullRequestInput {
    return inputSchema.parse(input);
  }

  governedAction(): string {
    return 'repository.pull_request.create';
  }

  summarize(input: PullRequestInput): string {
    return `Open a draft pull request in ${input.repository}: ${input.title}`;
  }

  async execute(_input: PullRequestInput, context: ToolExecutionContext): Promise<ToolOutput> {
    if (!context.governedAction)
      throw new RuntimeFailure('ACTION_NOT_AUTHORIZED', 'The pull request was not authorized.');
    const execution = await context.governedAction.execute();
    const result = execution.result;
    if (execution.status !== 'SUCCEEDED' || !result?.['url'])
      throw new RuntimeFailure(
        execution.error?.code ?? 'ACTION_FAILED',
        execution.error?.message ?? 'The pull request could not be opened.',
      );
    return {
      output: `Opened draft pull request #${result['pullRequestNumber']} (${result['url']}) from ${result['headBranch']}.`,
      artifactIds: [],
    };
  }
}
