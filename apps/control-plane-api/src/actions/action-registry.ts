import { z } from 'zod';
import type { ConnectorConnectionSettings, ConnectorProvider } from '@agents-foundry/contracts';
import { JiraIssueTrackerConnector } from './connectors/jira.js';

export interface DispatchContext {
  baseUrl: string;
  settings: ConnectorConnectionSettings;
  /** Resolved just before dispatch; never stored, logged or returned. */
  secret: string;
  fetch?: typeof fetch;
  signal: AbortSignal;
}

/**
 * A semantic action the control plane executes itself through a connector (ADR 0012).
 * Actions not listed here are executed by the runtime after an allow or approval decision.
 */
export interface ControlPlaneAction<P = Record<string, unknown>> {
  action: string;
  connectorProvider: ConnectorProvider;
  /** Connector capability the agent's manifest must grant for this provider. */
  requiredCapability: string;
  /** No transforms: the validated payload must be byte-identical to the approved one. */
  parameters: z.ZodType<P>;
  resource(parameters: P): { type: string; id: string };
  inScope(parameters: P, settings: ConnectorConnectionSettings): boolean;
  /** Written by the control plane from validated parameters; shown to approvers. */
  summary(parameters: P): string;
  dispatch(context: DispatchContext, parameters: P): Promise<Record<string, string>>;
  /**
   * What the audit log keeps of a successful result. Reads return work-item content, which
   * belongs to the run, not to the audit trail. Defaults to the whole result.
   */
  auditResult?(result: Record<string, string>): Record<string, string>;
}

function jiraConnector(context: DispatchContext): JiraIssueTrackerConnector {
  return new JiraIssueTrackerConnector({
    baseUrl: context.baseUrl,
    token: context.secret,
    ...(context.settings.authEmail ? { authEmail: context.settings.authEmail } : {}),
    ...(context.fetch ? { fetch: context.fetch } : {}),
  });
}

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, 'must not be blank');

const issueDraft = z
  .object({
    projectKey: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    summary: nonBlank(255).refine((value) => !/[\r\n]/.test(value), 'must be one line'),
    description: nonBlank(20_000),
    issueType: z.enum(['Bug', 'Task', 'Story']),
  })
  .strict();
type IssueDraftParameters = z.infer<typeof issueDraft>;

const jiraIssueCreate: ControlPlaneAction<IssueDraftParameters> = {
  action: 'jira.issue.create',
  connectorProvider: 'jira',
  requiredCapability: 'issueTracker.write',
  parameters: issueDraft,
  resource: (parameters) => ({ type: 'issue-tracker.project', id: parameters.projectKey }),
  inScope: (parameters, settings) => settings.allowedProjects.includes(parameters.projectKey),
  summary: (parameters) =>
    `Create Jira ${parameters.issueType.toLowerCase()} in ${parameters.projectKey}: ${parameters.summary}`.slice(
      0,
      500,
    ),
  async dispatch(context, parameters) {
    const issue = await jiraConnector(context).createIssue(parameters, context.signal);
    return { issueKey: issue.key, url: issue.url };
  },
};

const issueReference = z
  .object({ issueKey: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,8}$/) })
  .strict();
type IssueReferenceParameters = z.infer<typeof issueReference>;

/** Read one work item (Phase F): the story a QA run validates. Allowed projects only. */
const jiraRead: ControlPlaneAction<IssueReferenceParameters> = {
  action: 'jira.read',
  connectorProvider: 'jira',
  requiredCapability: 'issueTracker.read',
  parameters: issueReference,
  resource: (parameters) => ({ type: 'issue-tracker.issue', id: parameters.issueKey }),
  inScope: (parameters, settings) =>
    settings.allowedProjects.includes(parameters.issueKey.split('-')[0]!),
  summary: (parameters) => `Read Jira issue ${parameters.issueKey}`,
  async dispatch(context, parameters) {
    const issue = await jiraConnector(context).getIssue(parameters.issueKey, context.signal);
    return {
      issueKey: issue.key,
      summary: issue.summary,
      status: issue.status,
      issueType: issue.issueType,
      description: issue.description,
      descriptionTruncated: String(issue.descriptionTruncated),
      url: issue.url,
    };
  },
  auditResult: (result) => ({ issueKey: result['issueKey'] ?? '' }),
};

export const controlPlaneActions: Readonly<Record<string, ControlPlaneAction<never>>> = {
  [jiraIssueCreate.action]: jiraIssueCreate as unknown as ControlPlaneAction<never>,
  [jiraRead.action]: jiraRead as unknown as ControlPlaneAction<never>,
};

export function controlPlaneAction(action: string): ControlPlaneAction | undefined {
  return Object.hasOwn(controlPlaneActions, action)
    ? (controlPlaneActions[action] as unknown as ControlPlaneAction)
    : undefined;
}
