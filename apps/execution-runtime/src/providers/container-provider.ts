import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionOperation, ResourceLimits } from '@agents-foundry/contracts';
import { runProcess, type ProcessResult } from '../process-runner.js';
import type {
  EnforcedLimit,
  ExecutionProvider,
  ProviderOutcome,
  WorkspaceHandle,
} from './execution-provider.js';
import {
  LocalExecutionProvider,
  OperationFailure,
  bounded,
  failedProcess,
  inside,
  playwrightOutcome,
  processLogs,
  type LocalProviderOptions,
} from './local-provider.js';

export interface ContainerProviderOptions extends LocalProviderOptions {
  /** Image for `command` operations; it must already be present (`--pull never`). */
  image: string;
  /** Image with Playwright browsers for `playwright.run`. */
  playwrightImage?: string;
  /** Executables a `command` operation may start inside the container. Default: npm. */
  commands?: readonly string[];
  /**
   * Directory holding `egress-proxy.mjs` (ADR 0016). When set, grants that need network run on
   * a private internal network whose only route out is an allow-list proxy container.
   */
  egressProxyDirectory?: string;
  /** Image that runs the egress proxy; it needs `node`. Default: `image`. */
  egressProxyImage?: string;
  /**
   * Without an egress proxy: run grants that need network on the default bridge network with
   * no allow-list. Off by default, so such grants are refused.
   */
  allowUnrestrictedEgress?: boolean;
  dockerExecutable?: string;
  /** User inside the container; the image's unprivileged user by default. */
  user?: string;
}

/** Everything the docker CLI itself needs; none of it reaches the container. */
const DOCKER_CLIENT_ENV = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'TEMP',
  'TMP',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

export interface ContainerRun {
  name: string;
  image: string;
  workspaceRoot: string;
  /** Workspace-relative working directory. */
  cwd: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  limits: ResourceLimits;
  /** `none`, `bridge`, or the name of a run's internal network. */
  network: string;
  user: string;
}

/** Name the sandbox uses to reach the egress proxy on its internal network. */
export const EGRESS_PROXY_ALIAS = 'egress-proxy';
export const EGRESS_PROXY_PORT = 3128;
const EGRESS_PROXY_URL = `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}`;
/** Variables that point HTTP clients (npm, git, curl, Node fetch, Chromium) at the proxy. */
export const EGRESS_PROXY_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: EGRESS_PROXY_URL,
  HTTPS_PROXY: EGRESS_PROXY_URL,
  http_proxy: EGRESS_PROXY_URL,
  https_proxy: EGRESS_PROXY_URL,
  NODE_USE_ENV_PROXY: '1',
};

export interface EgressProxyRun {
  name: string;
  image: string;
  /** Host directory containing `egress-proxy.mjs`; mounted read-only. */
  directory: string;
  allowedHosts: readonly string[];
  user: string;
}

/** The directory shipped with this package that holds `egress-proxy.mjs`, if present. */
export function defaultEgressProxyDirectory(): string | null {
  // src/providers/ in development, dist/apps/execution-runtime/src/providers/ when built.
  for (const relative of ['../../sandbox/', '../../../../../sandbox/']) {
    const directory = fileURLToPath(new URL(relative, import.meta.url)).replace(/[\\/]$/, '');
    if (existsSync(join(directory, 'egress-proxy.mjs'))) return directory;
  }
  return null;
}

function mountable(path: string): string {
  if (/[,"\n]/.test(path)) throw new OperationFailure('WORKSPACE_PATH_UNSUPPORTED', '');
  return path;
}

/**
 * The `docker run` for a run's egress proxy: as locked down as the sandbox, on the default
 * bridge network (it is the only container with a route out), running only the mounted proxy
 * script with the grant's allowed hosts.
 */
export function egressProxyArgs(run: EgressProxyRun): string[] {
  if (run.allowedHosts.some((host) => !/^[A-Za-z0-9.:[\]-]+$/.test(host)))
    throw new OperationFailure('EGRESS_HOST_INVALID', 'The grant names an invalid host.');
  return [
    'run',
    '--detach',
    '--pull',
    'never',
    '--name',
    run.name,
    '--network',
    'bridge',
    '--cpus',
    '0.500',
    '--memory',
    '128m',
    '--memory-swap',
    '128m',
    '--pids-limit',
    '64',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--user',
    run.user,
    '--mount',
    `type=bind,source=${mountable(run.directory)},target=/egress,readonly`,
    '--env',
    `EGRESS_ALLOWED_HOSTS=${run.allowedHosts.join(',')}`,
    '--env',
    `EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`,
    run.image,
    'node',
    '/egress/egress-proxy.mjs',
  ];
}

/** One proxy decision, as the proxy logs it. */
interface EgressDecision {
  event: 'egress';
  decision: 'ALLOW' | 'DENY';
  method: string;
  host: string;
  port: number;
  reason?: string;
}

type Egress = 'none' | 'bridge' | { allowedHosts: readonly string[] };

/** Adds the egress log as evidence and tells the model which destinations were blocked. */
function withEgress(outcome: ProviderOutcome, decisions: EgressDecision[] | null): ProviderOutcome {
  if (decisions === null) return outcome;
  const denied = [
    ...new Set(
      decisions
        .filter((entry) => entry.decision === 'DENY')
        .map((entry) => `${entry.host}:${entry.port}`),
    ),
  ];
  const note = denied.length
    ? `\nNetwork access outside the grant was blocked: ${denied.join(', ')}`.slice(0, 500)
    : '';
  return {
    ...outcome,
    output: outcome.output + note,
    artifacts: [
      ...outcome.artifacts,
      ...(decisions.length
        ? [
            {
              name: 'egress.log',
              type: 'log' as const,
              mediaType: 'text/plain' as const,
              content: Buffer.from(
                decisions.map((entry) => JSON.stringify(entry)).join('\n'),
                'utf8',
              ),
            },
          ]
        : []),
    ],
  };
}

/**
 * The `docker run` argument vector for one operation: no capabilities, no privilege escalation,
 * a read-only root filesystem, CPU, memory and process limits from the grant, the workspace as
 * the only writable mount, and only the environment given here (nothing from the runtime).
 */
export function dockerRunArgs(run: ContainerRun): string[] {
  mountable(run.workspaceRoot);
  const cwd = run.cwd === '.' ? '/workspace' : `/workspace/${run.cwd}`;
  return [
    'run',
    '--rm',
    '--pull',
    'never',
    '--name',
    run.name,
    '--network',
    run.network,
    '--cpus',
    (run.limits.cpuMillis / 1000).toFixed(3),
    '--memory',
    `${run.limits.memoryMb}m`,
    '--memory-swap',
    `${run.limits.memoryMb}m`,
    '--pids-limit',
    String(run.limits.maxProcesses),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=512m',
    '--user',
    run.user,
    '--mount',
    `type=bind,source=${run.workspaceRoot},target=/workspace`,
    '--workdir',
    cwd,
    ...Object.entries(run.env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    run.image,
    ...run.argv,
  ];
}

/**
 * Sandboxing provider (Phase G). Repository code only ever executes inside a container:
 * `command` and `playwright.run` run under the grant's CPU, memory, process and network limits
 * with no capabilities and a read-only root filesystem. Operations that execute no repository
 * code (git checkout and status, file read and write) run on the host through the local
 * provider's confined, hook-free implementation.
 *
 * Network: grants with no hosts run with `--network none`. Grants with an allow-list run on a
 * private `--internal` network created for the operation; its only other member is an egress
 * proxy container that forwards to the allowed hosts and nothing else (ADR 0016). Without a
 * proxy such grants are refused (`EGRESS_CONTROL_UNAVAILABLE`) unless the operator accepts
 * unrestricted egress. Git checkout on the host reaches only the repository the control plane
 * scoped the grant to, but is not network-isolated.
 */
export class ContainerExecutionProvider implements ExecutionProvider {
  readonly id = 'container';
  readonly isolation = 'sandboxed' as const;
  readonly enforces: readonly EnforcedLimit[] = [
    'timeout',
    'output',
    'filesystem',
    'environment',
    'cpu',
    'memory',
    'processes',
    'network',
  ];
  private readonly host: LocalExecutionProvider;

  constructor(private readonly options: ContainerProviderOptions) {
    this.host = new LocalExecutionProvider(options);
  }

  async execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    if (operation.kind !== 'command' && operation.kind !== 'playwright.run')
      return this.host.execute(workspace, operation, limits, signal);
    try {
      const network = this.network(limits);
      return operation.kind === 'command'
        ? await this.command(workspace, operation, limits, network, signal)
        : await this.playwright(workspace, operation, limits, network, signal);
    } catch (error) {
      if (error instanceof OperationFailure)
        return {
          status: error.code === 'EGRESS_CONTROL_UNAVAILABLE' ? 'DENIED' : 'FAILED',
          error: { code: error.code, message: error.message.slice(0, 500) },
          output: '',
          truncated: false,
          artifacts: [],
        };
      throw error;
    }
  }

  private network(limits: ResourceLimits): Egress {
    if (limits.network.mode === 'NONE') return 'none';
    if (this.options.egressProxyDirectory) return { allowedHosts: limits.network.allowedHosts };
    if (this.options.allowUnrestrictedEgress) return 'bridge';
    throw new OperationFailure(
      'EGRESS_CONTROL_UNAVAILABLE',
      `This operation needs network access to ${limits.network.allowedHosts.join(', ')}, and ` +
        'the container provider cannot restrict egress to an allow-list.',
    );
  }

  private async command(
    workspace: WorkspaceHandle,
    operation: Extract<ExecutionOperation, { kind: 'command' }>,
    limits: ResourceLimits,
    network: Egress,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    if (!(this.options.commands ?? ['npm']).includes(operation.command))
      throw new OperationFailure(
        'COMMAND_NOT_ALLOWED',
        `${operation.command} is not an allowed command.`,
      );
    await inside(workspace.root, operation.cwd, true);
    const { result, egress } = await this.run(
      workspace,
      this.options.image,
      operation.cwd,
      [operation.command, ...operation.args],
      {},
      limits,
      network,
      signal,
    );
    const what = [operation.command, ...operation.args].join(' ');
    if (result.exitCode !== 0 || result.timedOut)
      return withEgress(failedProcess(result, 'COMMAND_FAILED', what), egress);
    return withEgress(
      {
        status: 'SUCCEEDED',
        exitCode: 0,
        ...bounded(`${what} succeeded.\n${result.stdout}`.trim()),
        artifacts: processLogs(result, 'command.log'),
      },
      egress,
    );
  }

  private async playwright(
    workspace: WorkspaceHandle,
    operation: Extract<ExecutionOperation, { kind: 'playwright.run' }>,
    limits: ResourceLimits,
    network: Egress,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const directory = operation.path ?? '.';
    await inside(workspace.root, directory, true);
    try {
      await inside(
        workspace.root,
        [directory, 'node_modules/@playwright/test/cli.js'].join('/').replace(/^\.\//, ''),
        true,
      );
    } catch {
      throw new OperationFailure(
        'PLAYWRIGHT_NOT_INSTALLED',
        'The project has no installed @playwright/test; dependency installation is not supported yet.',
      );
    }
    const { result, egress } = await this.run(
      workspace,
      this.options.playwrightImage ?? this.options.image,
      directory,
      [
        'node',
        'node_modules/@playwright/test/cli.js',
        'test',
        `--project=${operation.project}`,
        '--reporter=json',
      ],
      { BASE_URL: operation.baseUrl, PLAYWRIGHT_BASE_URL: operation.baseUrl },
      limits,
      network,
      signal,
    );
    return withEgress(playwrightOutcome(result, operation), egress);
  }

  private async run(
    workspace: WorkspaceHandle,
    image: string,
    cwd: string,
    argv: readonly string[],
    env: Record<string, string>,
    limits: ResourceLimits,
    egress: Egress,
    signal: AbortSignal,
  ): Promise<{ result: ProcessResult; egress: EgressDecision[] | null }> {
    const docker = this.options.dockerExecutable ?? 'docker';
    const id = randomUUID();
    const name = `af-exec-${id}`;
    const proxied = typeof egress === 'object' ? egress : null;
    const network = proxied ? `af-net-${id}` : (egress as 'none' | 'bridge');
    const proxy = `af-egress-${id}`;
    const clientEnv: Record<string, string> = {};
    for (const key of DOCKER_CLIENT_ENV) if (process.env[key]) clientEnv[key] = process.env[key]!;
    const user = this.options.user ?? '1000:1000';
    const args = dockerRunArgs({
      name,
      image,
      workspaceRoot: workspace.root,
      cwd,
      argv,
      env: {
        HOME: '/tmp',
        CI: '1',
        npm_config_cache: '/tmp/.npm',
        ...(proxied ? EGRESS_PROXY_ENV : {}),
        ...env,
      },
      limits,
      network,
      user,
    });
    const options = {
      cwd: workspace.root,
      env: clientEnv,
      maxOutputBytes: this.options.maxOutputBytes ?? 1024 * 1024,
    };
    const client = (command: string[], timeoutMs = 30_000) =>
      runProcess(docker, command, { ...options, timeoutMs });
    try {
      if (proxied) {
        const created = await client(['network', 'create', '--internal', network]);
        if (created.exitCode !== 0)
          throw new OperationFailure(
            'EGRESS_PROXY_UNAVAILABLE',
            'The sandbox network could not be created.',
          );
        await this.startProxy(
          client,
          {
            name: proxy,
            image: this.options.egressProxyImage ?? this.options.image,
            directory: this.options.egressProxyDirectory!,
            allowedHosts: proxied.allowedHosts,
            user,
          },
          network,
          signal,
        );
      }
      const result = await runProcess(docker, args, {
        ...options,
        timeoutMs: limits.timeoutMs,
        signal,
      });
      if (result.exitCode === 125 && /No such image|pull access denied/i.test(result.stderr))
        throw new OperationFailure('SANDBOX_IMAGE_UNAVAILABLE', `Image ${image} is not present.`);
      return { result, egress: proxied ? await this.decisions(client, proxy) : null };
    } finally {
      // Killing the docker client does not stop the container; remove it explicitly.
      await client(['rm', '--force', name]);
      if (proxied) {
        await client(['rm', '--force', proxy]);
        await client(['network', 'rm', network]);
      }
    }
  }

  /** Starts the proxy on the bridge network, joins it to the sandbox network and waits for it. */
  private async startProxy(
    client: (command: string[], timeoutMs?: number) => Promise<ProcessResult>,
    run: EgressProxyRun,
    network: string,
    signal: AbortSignal,
  ): Promise<void> {
    const started = await client(egressProxyArgs(run));
    if (started.exitCode !== 0)
      throw /No such image|pull access denied/i.test(started.stderr)
        ? new OperationFailure('SANDBOX_IMAGE_UNAVAILABLE', `Image ${run.image} is not present.`)
        : new OperationFailure('EGRESS_PROXY_UNAVAILABLE', 'The egress proxy did not start.');
    const connected = await client([
      'network',
      'connect',
      '--alias',
      EGRESS_PROXY_ALIAS,
      network,
      run.name,
    ]);
    if (connected.exitCode !== 0)
      throw new OperationFailure('EGRESS_PROXY_UNAVAILABLE', 'The egress proxy is unreachable.');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !signal.aborted) {
      const logs = await client(['logs', run.name]);
      if (logs.stdout.includes('"event":"ready"')) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new OperationFailure('EGRESS_PROXY_UNAVAILABLE', 'The egress proxy did not start.');
  }

  /** The proxy's decisions for this operation; unparseable lines are ignored. */
  private async decisions(
    client: (command: string[], timeoutMs?: number) => Promise<ProcessResult>,
    proxy: string,
  ): Promise<EgressDecision[]> {
    const logs = await client(['logs', proxy]);
    const decisions: EgressDecision[] = [];
    for (const line of logs.stdout.split('\n'))
      try {
        const entry = JSON.parse(line) as Partial<EgressDecision>;
        if (entry.event === 'egress') decisions.push(entry as EgressDecision);
      } catch {
        /* Not a decision. */
      }
    return decisions.slice(0, 1000);
  }
}
