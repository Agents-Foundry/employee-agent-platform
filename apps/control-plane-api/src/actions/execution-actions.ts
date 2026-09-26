import type { ExecutionOperation, ExecutionOperationKind } from '@agents-foundry/contracts';

type Configuration = Record<string, string | string[]>;

/**
 * A governed action performed by an execution runtime under a signed grant (ADR 0013). The
 * control plane binds the grant to one operation and checks that the operation's external
 * target lies inside the agent's own signed configuration.
 */
export interface ExecutionAction {
  action: string;
  operations: readonly ExecutionOperationKind[];
  resource(operation: ExecutionOperation): { type: string; id: string };
  inScope(operation: ExecutionOperation, configuration: Configuration): boolean;
  /** Hosts the operation needs to reach; everything else stays unreachable by intent. */
  hosts(operation: ExecutionOperation): string[];
  /** Written by the control plane from the validated operation; shown to approvers. */
  summary(operation: ExecutionOperation): string;
}

function text(configuration: Configuration, key: string): string | null {
  const value = configuration[key];
  return typeof value === 'string' ? value : null;
}

/** Compare repository URLs ignoring case of the host, a trailing slash and a `.git` suffix. */
export function sameRepository(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
    } catch {
      return null;
    }
  };
  const a = normalize(left);
  return a !== null && a === normalize(right);
}

function origin(value: string | null): string | null {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

const repositoryRead: ExecutionAction = {
  action: 'repository.read',
  operations: ['git.checkout', 'git.status', 'file.read'],
  resource: (operation) =>
    operation.kind === 'git.checkout'
      ? { type: 'repository', id: operation.repositoryUrl }
      : { type: 'workspace.path', id: ('path' in operation && operation.path) || '.' },
  inScope: (operation, configuration) => {
    if (operation.kind !== 'git.checkout') return true;
    const configured = text(configuration, 'repositoryUrl');
    return configured !== null && sameRepository(operation.repositoryUrl, configured);
  },
  hosts: (operation) =>
    operation.kind === 'git.checkout' && operation.repositoryUrl.startsWith('https:')
      ? [new URL(operation.repositoryUrl).hostname]
      : [],
  summary: (operation) =>
    operation.kind === 'git.checkout'
      ? `Check out ${operation.ref} of ${operation.repositoryUrl}`
      : operation.kind === 'git.status'
        ? `Read git status of ${operation.path}`
        : `Read ${('path' in operation && operation.path) || '.'}`,
};

const playwrightRun: ExecutionAction = {
  action: 'qa.execute_playwright',
  operations: ['playwright.run'],
  resource: (operation) => ({
    type: 'environment',
    id: operation.kind === 'playwright.run' ? new URL(operation.baseUrl).origin : '',
  }),
  inScope: (operation, configuration) =>
    operation.kind === 'playwright.run' &&
    origin(operation.baseUrl) !== null &&
    origin(operation.baseUrl) === origin(text(configuration, 'qaUrl')),
  hosts: (operation) =>
    operation.kind === 'playwright.run' ? [new URL(operation.baseUrl).hostname] : [],
  summary: (operation) =>
    operation.kind === 'playwright.run'
      ? `Run Playwright project ${operation.project} against ${new URL(operation.baseUrl).origin}`
      : 'Run Playwright',
};

const registry: Readonly<Record<string, ExecutionAction>> = {
  [repositoryRead.action]: repositoryRead,
  [playwrightRun.action]: playwrightRun,
};

export function executionAction(action: string): ExecutionAction | undefined {
  return Object.hasOwn(registry, action) ? registry[action] : undefined;
}
