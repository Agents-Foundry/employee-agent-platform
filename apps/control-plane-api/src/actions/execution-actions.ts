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

/** Write a file inside the agent's workspace (Phase G). Nothing outside the workspace changes. */
const repositoryWrite: ExecutionAction = {
  action: 'repository.write',
  operations: ['file.write'],
  resource: (operation) => ({
    type: 'workspace.path',
    id: operation.kind === 'file.write' ? operation.path : '',
  }),
  inScope: () => true,
  hosts: () => [],
  summary: (operation) =>
    operation.kind === 'file.write'
      ? `Write ${new TextEncoder().encode(operation.content).byteLength} bytes to ${operation.path}`
      : 'Write a file',
};

/** Default project scripts when the agent's configuration names none. */
export const DEFAULT_PROJECT_SCRIPTS = ['build', 'lint', 'test'] as const;

/** Scripts the agent may run: the configured `projectScripts` (comma-separated) or defaults. */
export function projectScripts(configuration: Configuration): string[] {
  const configured = text(configuration, 'projectScripts');
  const scripts = configured
    ? configured
        .split(',')
        .map((script) => script.trim())
        .filter((script) => /^[a-z0-9][a-z0-9:._-]{0,59}$/.test(script))
    : [];
  return scripts.length ? scripts : [...DEFAULT_PROJECT_SCRIPTS];
}

/**
 * Run one allow-listed project script (`npm run <script>`) in the workspace (Phase G). No hosts:
 * the grant carries `network: NONE`, so dependencies must already be in the workspace.
 */
const workspaceCommand: ExecutionAction = {
  action: 'workspace.command',
  operations: ['command'],
  resource: (operation) => ({
    type: 'workspace.command',
    id: operation.kind === 'command' ? [operation.command, ...operation.args].join(' ') : '',
  }),
  inScope: (operation, configuration) =>
    operation.kind === 'command' &&
    operation.command === 'npm' &&
    operation.args.length === 2 &&
    operation.args[0] === 'run' &&
    projectScripts(configuration).includes(operation.args[1]!),
  hosts: () => [],
  summary: (operation) =>
    operation.kind === 'command'
      ? `Run ${[operation.command, ...operation.args].join(' ')} in ${operation.cwd}`
      : 'Run a project script',
};

/** A registry URL without credentials, query or fragment, compared without a trailing slash. */
function registryKey(value: string | null): string | null {
  try {
    const url = value ? new URL(value) : null;
    if (!url || url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Install the project's locked dependencies (ADR 0017). The registry must be the HTTPS
 * `packageRegistryUrl` in the agent's signed configuration; the grant allows only its host,
 * which the execution runtime's egress proxy enforces.
 */
const dependenciesInstall: ExecutionAction = {
  action: 'workspace.dependencies.install',
  operations: ['dependencies.install'],
  resource: (operation) => ({
    type: 'package.registry',
    id: operation.kind === 'dependencies.install' ? (registryKey(operation.registryUrl) ?? '') : '',
  }),
  inScope: (operation, configuration) => {
    const configured = registryKey(text(configuration, 'packageRegistryUrl'));
    return (
      operation.kind === 'dependencies.install' &&
      configured !== null &&
      configured.startsWith('https://') &&
      registryKey(operation.registryUrl) === configured
    );
  },
  hosts: (operation) =>
    operation.kind === 'dependencies.install' ? [new URL(operation.registryUrl).hostname] : [],
  summary: (operation) =>
    operation.kind === 'dependencies.install'
      ? `Install locked npm dependencies in ${operation.path} from ${operation.registryUrl}`
      : 'Install dependencies',
};

const registry: Readonly<Record<string, ExecutionAction>> = {
  [repositoryRead.action]: repositoryRead,
  [repositoryWrite.action]: repositoryWrite,
  [workspaceCommand.action]: workspaceCommand,
  [dependenciesInstall.action]: dependenciesInstall,
  [playwrightRun.action]: playwrightRun,
};

export function executionAction(action: string): ExecutionAction | undefined {
  return Object.hasOwn(registry, action) ? registry[action] : undefined;
}
