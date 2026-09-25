import { z } from 'zod';
import { RuntimeFailure } from '../errors.js';
import type { RuntimeTool, ToolExecutionContext, ToolOutput } from './runtime-tool.js';

const inputSchema = z
  .object({
    projectKey: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    summary: z
      .string()
      .max(255)
      .refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value), 'one non-blank line'),
    description: z
      .string()
      .max(20_000)
      .refine((value) => value.trim().length > 0, 'must not be blank'),
    issueType: z.enum(['Bug', 'Task', 'Story']),
  })
  .strict();
type IssueInput = z.infer<typeof inputSchema>;

/**
 * Catalog tool `issue-tracker@1.0.0`: files an issue through the Action Gateway. The runtime
 * holds no connector, credential or authorization logic; the control plane decides, asks for
 * approval, and performs the write exactly once (ADR 0012).
 */
export class IssueTrackerTool implements RuntimeTool<IssueInput> {
  readonly id = 'issue-tracker';
  readonly version = '1.0.0';
  readonly sendsParameters = true;
  readonly description =
    'File an issue (for example a defect you found) in the organization issue tracker. The ' +
    'request may need human approval, and only configured projects are allowed.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['projectKey', 'summary', 'description', 'issueType'],
    properties: {
      projectKey: { type: 'string', description: 'Project key, for example "QA".' },
      summary: { type: 'string', description: 'One-line title.' },
      description: { type: 'string', description: 'Steps, expected and actual behaviour.' },
      issueType: { type: 'string', enum: ['Bug', 'Task', 'Story'] },
    },
  };

  parse(input: unknown): IssueInput {
    return inputSchema.parse(input);
  }

  governedAction(): string {
    return 'jira.issue.create';
  }

  summarize(input: IssueInput): string {
    return `Create ${input.issueType} in ${input.projectKey}: ${input.summary}`;
  }

  async execute(_input: IssueInput, context: ToolExecutionContext): Promise<ToolOutput> {
    if (!context.governedAction)
      throw new RuntimeFailure('ACTION_NOT_AUTHORIZED', 'The issue write was not authorized.');
    const execution = await context.governedAction.execute();
    if (execution.status !== 'SUCCEEDED' || !execution.result?.['issueKey'])
      throw new RuntimeFailure(
        execution.error?.code ?? 'ACTION_FAILED',
        execution.error?.message ?? 'The issue could not be created.',
      );
    const { issueKey, url } = execution.result;
    return { output: `Created ${issueKey}${url ? ` (${url})` : ''}.`, artifactIds: [] };
  }
}
