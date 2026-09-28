import { z } from 'zod';
import type { ConnectorConnectionSettings, ConnectorProvider } from '@agents-foundry/contracts';
import { GitHubSourceControlConnector, type ChangedFile } from './connectors/github.js';
import { JiraIssueTrackerConnector } from './connectors/jira.js';

type Configuration = Record<string, string | string[]>;

/**
 * Files written in the agent's workspace, as the control plane recorded them (Phase G). The
 * digest is what an approver approves; dispatch publishes only an identical change set.
 */
export interface ChangeSet {
  digest: string;
  files: ChangedFile[];
}

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
  /** The target must be allowed by the connection and, where relevant, the agent's configuration. */
  inScope(
    parameters: P,
    settings: ConnectorConnectionSettings,
    configuration: Configuration,
  ): boolean;
  /**
   * For actions that publish workspace changes: the workspace directory whose recorded writes
   * form the change set. The gateway resolves it; the runtime never supplies file contents.
   */
  changeSetDirectory?(parameters: P): string;
  /** Written by the control plane from validated parameters; shown to approvers. */
  summary(parameters: P, changes: ChangeSet | null): string;
  dispatch(
    context: DispatchContext,
    parameters: P,
    changes: ChangeSet | null,
  ): Promise<Record<string, string>>;
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

const oneLine = (max: number) =>
  nonBlank(max).refine((value) => !/[\r\n]/.test(value), 'must be one line');

const pullRequest = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
    baseBranch: z
      .string()
      .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/)
      .refine((value) => !value.endsWith('/') && !value.endsWith('.lock'), 'invalid branch'),
    /** New branches only, in a namespace people can recognise and clean up. */
    headBranch: z.string().regex(/^agents-foundry\/[a-z0-9][a-z0-9._-]{0,79}$/),
    title: oneLine(200),
    body: z.string().max(20_000),
    /** Workspace directory the repository was checked out into, for example "repo". */
    path: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/),
  })
  .strict();
type PullRequestParameters = z.infer<typeof pullRequest>;

/** The configured repository URL names this `owner/name` (any host; the connection fixes it). */
function configuredRepository(configuration: Configuration, repository: string): boolean {
  const value = configuration['repositoryUrl'];
  if (typeof value !== 'string') return false;
  try {
    const path = new URL(value).pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return path.toLowerCase() === `/${repository.toLowerCase()}`;
  } catch {
    return false;
  }
}

/**
 * Open a draft pull request with the workspace changes (Phase G). The change set is resolved
 * and digested by the control plane from recorded, completed `repository.write` operations.
 */
const pullRequestCreate: ControlPlaneAction<PullRequestParameters> = {
  action: 'repository.pull_request.create',
  connectorProvider: 'github',
  requiredCapability: 'sourceControl.write',
  parameters: pullRequest,
  resource: (parameters) => ({ type: 'repository', id: parameters.repository }),
  inScope: (parameters, settings, configuration) =>
    (settings.allowedRepositories ?? []).some(
      (allowed) => allowed.toLowerCase() === parameters.repository.toLowerCase(),
    ) && configuredRepository(configuration, parameters.repository),
  changeSetDirectory: (parameters) => parameters.path,
  summary: (parameters, changes) => {
    const files = changes?.files.map((file) => file.path) ?? [];
    const listed = files.slice(0, 10).join(', ') + (files.length > 10 ? ', …' : '');
    return (
      `Open a draft pull request in ${parameters.repository} from ${parameters.headBranch} ` +
      `into ${parameters.baseBranch}: "${parameters.title}". ${files.length} file(s): ${listed}. ` +
      `Change set ${changes?.digest.slice(0, 12) ?? 'none'}.`
    ).slice(0, 500);
  },
  async dispatch(context, parameters, changes) {
    const created = await new GitHubSourceControlConnector({
      baseUrl: context.baseUrl,
      token: context.secret,
      ...(context.fetch ? { fetch: context.fetch } : {}),
    }).createPullRequest(parameters, changes?.files ?? [], context.signal);
    return {
      pullRequestNumber: String(created.number),
      url: created.url,
      headBranch: parameters.headBranch,
      commitSha: created.commitSha,
    };
  },
};

export const controlPlaneActions: Readonly<Record<string, ControlPlaneAction<never>>> = {
  [jiraIssueCreate.action]: jiraIssueCreate as unknown as ControlPlaneAction<never>,
  [jiraRead.action]: jiraRead as unknown as ControlPlaneAction<never>,
  [pullRequestCreate.action]: pullRequestCreate as unknown as ControlPlaneAction<never>,
};

export function controlPlaneAction(action: string): ControlPlaneAction | undefined {
  return Object.hasOwn(controlPlaneActions, action)
    ? (controlPlaneActions[action] as unknown as ControlPlaneAction)
    : undefined;
}
