import { ConnectorError, writeFailure } from './connector-error.js';

/** One file of a change set, repository-relative. */
export interface ChangedFile {
  path: string;
  content: string;
}

export interface PullRequestDraft {
  /** `owner/name`. */
  repository: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}

export interface CreatedPullRequest {
  number: number;
  url: string;
  commitSha: string;
}

/** Typed capability contract (ADR 0015). Connectors hold no authorization logic. */
export interface SourceControlConnector {
  createPullRequest(
    draft: PullRequestDraft,
    changes: readonly ChangedFile[],
    signal: AbortSignal,
  ): Promise<CreatedPullRequest>;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * GitHub REST v3. Publishes a change set as one commit on a new branch and opens a **draft**
 * pull request, entirely through the API: no clone, no push credentials in any workspace.
 * Creating the branch fails if it already exists, so nothing is ever overwritten.
 */
export class GitHubSourceControlConnector implements SourceControlConnector {
  constructor(private readonly options: { baseUrl: string; token: string; fetch?: typeof fetch }) {}

  async createPullRequest(
    draft: PullRequestDraft,
    changes: readonly ChangedFile[],
    signal: AbortSignal,
  ): Promise<CreatedPullRequest> {
    const [owner, name] = draft.repository.split('/') as [string, string];
    const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const branch = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
    const base = await this.call<{ object?: { sha?: unknown } }>(
      'GET',
      `${repo}/git/ref/heads/${branch(draft.baseBranch)}`,
      signal,
    );
    const baseSha = this.sha(base.object?.sha);
    const baseCommit = await this.call<{ tree?: { sha?: unknown } }>(
      'GET',
      `${repo}/git/commits/${baseSha}`,
      signal,
    );
    const tree = await this.call<{ sha?: unknown }>('POST', `${repo}/git/trees`, signal, {
      base_tree: this.sha(baseCommit.tree?.sha),
      tree: changes.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        content: file.content,
      })),
    });
    const commit = await this.call<{ sha?: unknown }>('POST', `${repo}/git/commits`, signal, {
      message: draft.title,
      tree: this.sha(tree.sha),
      parents: [baseSha],
    });
    const commitSha = this.sha(commit.sha);
    // Trees and commits are unreferenced objects nobody sees. From here on the repository
    // changes visibly, so a request GitHub does not confirm may have been applied.
    await this.call(
      'POST',
      `${repo}/git/refs`,
      signal,
      { ref: `refs/heads/${draft.headBranch}`, sha: commitSha },
      true,
    );
    let pull: { number?: unknown; html_url?: unknown };
    try {
      pull = await this.call(
        'POST',
        `${repo}/pulls`,
        signal,
        {
          title: draft.title,
          head: draft.headBranch,
          base: draft.baseBranch,
          body: draft.body,
          draft: true,
        },
        true,
      );
    } catch (error) {
      // The branch exists whatever happened to the pull request: the change is part-published.
      throw new ConnectorError(
        'CONNECTOR_OUTCOME_UNKNOWN',
        error instanceof ConnectorError ? error.status : undefined,
      );
    }
    if (
      typeof pull.number !== 'number' ||
      !Number.isInteger(pull.number) ||
      typeof pull.html_url !== 'string' ||
      !pull.html_url.startsWith('https://')
    )
      throw new ConnectorError('CONNECTOR_OUTCOME_UNKNOWN');
    return { number: pull.number, url: pull.html_url.slice(0, 500), commitSha };
  }

  private sha(value: unknown): string {
    if (typeof value !== 'string' || !SHA.test(value))
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID');
    return value;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    body?: unknown,
    /** The request changes something people can see in the repository. */
    visible = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl.replace(/\/+$/, '')}${path}`,
        {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.options.token}`,
            'user-agent': 'agents-foundry',
            'x-github-api-version': '2022-11-28',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal,
        },
      );
    } catch {
      throw new ConnectorError(visible ? 'CONNECTOR_OUTCOME_UNKNOWN' : 'CONNECTOR_REQUEST_FAILED');
    }
    if (!response.ok)
      throw visible
        ? writeFailure(response.status)
        : new ConnectorError('CONNECTOR_REQUEST_FAILED', response.status);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ConnectorError(
        visible ? 'CONNECTOR_OUTCOME_UNKNOWN' : 'CONNECTOR_RESPONSE_INVALID',
        response.status,
      );
    }
  }
}
