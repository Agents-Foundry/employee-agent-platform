/** Typed capability contract (ADR 0012). Connectors hold no authorization logic. */
export interface IssueDraft {
  projectKey: string;
  summary: string;
  description: string;
  issueType: 'Bug' | 'Task' | 'Story';
}

/** A work item as the agent sees it: plain text only, bounded. */
export interface IssueSnapshot {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  description: string;
  descriptionTruncated: boolean;
  url: string;
}

export interface IssueTrackerConnector {
  createIssue(draft: IssueDraft, signal: AbortSignal): Promise<{ key: string; url: string }>;
  getIssue(key: string, signal: AbortSignal): Promise<IssueSnapshot>;
}

/** Longest description returned to an agent; action results are bounded (runtime/v1). */
export const ISSUE_DESCRIPTION_LIMIT = 2000;

const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,19}-\d{1,9}$/;

/** Flatten Atlassian Document Format to text; unknown nodes contribute only their children. */
function adfText(node: unknown, depth = 0): string {
  if (depth > 40 || !node || typeof node !== 'object') return '';
  const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
  if (type === 'text' && typeof text === 'string') return text;
  if (type === 'hardBreak') return '\n';
  const inner = Array.isArray(content)
    ? content.map((child) => adfText(child, depth + 1)).join('')
    : '';
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(String(type))
    ? `${inner}\n`
    : inner;
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').slice(0, max) : '';
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

  private get base(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  private get authorization(): string {
    return this.options.authEmail
      ? `Basic ${Buffer.from(`${this.options.authEmail}:${this.options.token}`).toString('base64')}`
      : `Bearer ${this.options.token}`;
  }

  async getIssue(key: string, signal: AbortSignal): Promise<IssueSnapshot> {
    if (!ISSUE_KEY.test(key)) throw new ConnectorError('CONNECTOR_REQUEST_FAILED');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,description`,
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: this.authorization },
          redirect: 'error',
          signal,
        },
      );
    } catch {
      throw new ConnectorError('CONNECTOR_REQUEST_FAILED');
    }
    if (!response.ok) throw new ConnectorError('CONNECTOR_REQUEST_FAILED', response.status);
    let body: { key?: unknown; fields?: Record<string, unknown> };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID');
    }
    // The issue must be the one asked for: a confused or hostile server cannot substitute one.
    if (body.key !== key || !body.fields || typeof body.fields !== 'object')
      throw new ConnectorError('CONNECTOR_RESPONSE_INVALID');
    const fields = body.fields;
    const description = adfText(fields['description'])
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      key,
      summary: oneLine(fields['summary'], 255),
      status: oneLine((fields['status'] as { name?: unknown } | undefined)?.name, 60),
      issueType: oneLine((fields['issuetype'] as { name?: unknown } | undefined)?.name, 60),
      description: description.slice(0, ISSUE_DESCRIPTION_LIMIT),
      descriptionTruncated: description.length > ISSUE_DESCRIPTION_LIMIT,
      url: `${this.base}/browse/${key}`,
    };
  }

  async createIssue(draft: IssueDraft, signal: AbortSignal): Promise<{ key: string; url: string }> {
    const base = this.base;
    const authorization = this.authorization;
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
