/** Typed capability contract (ADR 0012). Connectors hold no authorization logic. */
export interface IssueDraft {
  projectKey: string;
  summary: string;
  description: string;
  issueType: 'Bug' | 'Task' | 'Story';
}

export interface IssueTrackerConnector {
  createIssue(draft: IssueDraft, signal: AbortSignal): Promise<{ key: string; url: string }>;
}

/** A connector failure. Codes and status only: provider bodies can echo credentials or data. */
export class ConnectorError extends Error {
  constructor(
    readonly code: 'CONNECTOR_REQUEST_FAILED' | 'CONNECTOR_RESPONSE_INVALID',
    readonly status?: number,
  ) {
    super(code);
  }
}

function paragraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({ type: 'paragraph', content: [{ type: 'text', text: block }] }));
}

/** Jira Cloud REST v3. Basic auth (email + API token) when an email is set, bearer otherwise. */
export class JiraIssueTrackerConnector implements IssueTrackerConnector {
  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      authEmail?: string;
      fetch?: typeof fetch;
    },
  ) {}

  async createIssue(draft: IssueDraft, signal: AbortSignal): Promise<{ key: string; url: string }> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const authorization = this.options.authEmail
      ? `Basic ${Buffer.from(`${this.options.authEmail}:${this.options.token}`).toString('base64')}`
      : `Bearer ${this.options.token}`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${base}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization,
        },
        body: JSON.stringify({
          fields: {
            project: { key: draft.projectKey },
            summary: draft.summary,
            issuetype: { name: draft.issueType },
            description: { type: 'doc', version: 1, content: paragraphs(draft.description) },
          },
        }),
        redirect: 'error',
        signal,
      });
    } catch {
      throw new ConnectorError('CONNECTOR_REQUEST_FAILED');
    }
    if (!response.ok) throw new ConnectorError('CONNECTOR_REQUEST_FAILED', response.status);
    let key: unknown;
    try {
      key = ((await response.json()) as { key?: unknown }).key;
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID');
    }
    if (typeof key !== 'string' || !/^[A-Z][A-Z0-9]{0,19}-\d{1,9}$/.test(key))
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID');
    return { key, url: `${base}/browse/${key}` };
  }
}
