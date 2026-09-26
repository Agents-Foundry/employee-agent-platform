import { randomUUID } from 'node:crypto';
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
   * Run grants that need network access (an allow-list) on the default bridge network. The
   * provider cannot restrict egress to the allow-list, so this is off by default and such
   * grants are refused.
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
  network: 'none' | 'bridge';
  user: string;
}

/**
 * The `docker run` argument vector for one operation: no capabilities, no privilege escalation,
 * a read-only root filesystem, CPU, memory and process limits from the grant, the workspace as
 * the only writable mount, and only the environment given here (nothing from the runtime).
 */
export function dockerRunArgs(run: ContainerRun): string[] {
  if (/[,"\n]/.test(run.workspaceRoot))
    throw new OperationFailure('WORKSPACE_PATH_UNSUPPORTED', '');
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
 * Network: grants with no hosts run with `--network none`. The provider cannot limit egress to
 * an allow-list, so grants that need network are refused (`EGRESS_CONTROL_UNAVAILABLE`) unless
 * the operator accepts unrestricted egress. Git checkout on the host reaches only the
 * repository the control plane scoped the grant to, but is not network-isolated.
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

  private network(limits: ResourceLimits): 'none' | 'bridge' {
    if (limits.network.mode === 'NONE') return 'none';
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
    network: 'none' | 'bridge',
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    if (!(this.options.commands ?? ['npm']).includes(operation.command))
      throw new OperationFailure(
        'COMMAND_NOT_ALLOWED',
        `${operation.command} is not an allowed command.`,
      );
    await inside(workspace.root, operation.cwd, true);
    const result = await this.run(
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
      return failedProcess(result, 'COMMAND_FAILED', what);
    return {
      status: 'SUCCEEDED',
      exitCode: 0,
      ...bounded(`${what} succeeded.\n${result.stdout}`.trim()),
      artifacts: processLogs(result, 'command.log'),
    };
  }

  private async playwright(
    workspace: WorkspaceHandle,
    operation: Extract<ExecutionOperation, { kind: 'playwright.run' }>,
    limits: ResourceLimits,
    network: 'none' | 'bridge',
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
    const result = await this.run(
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
    return playwrightOutcome(result, operation);
  }

  private async run(
    workspace: WorkspaceHandle,
    image: string,
    cwd: string,
    argv: readonly string[],
    env: Record<string, string>,
    limits: ResourceLimits,
    network: 'none' | 'bridge',
    signal: AbortSignal,
  ): Promise<ProcessResult> {
    const docker = this.options.dockerExecutable ?? 'docker';
    const name = `af-exec-${randomUUID()}`;
    const clientEnv: Record<string, string> = {};
    for (const key of DOCKER_CLIENT_ENV) if (process.env[key]) clientEnv[key] = process.env[key]!;
    const args = dockerRunArgs({
      name,
      image,
      workspaceRoot: workspace.root,
      cwd,
      argv,
      env: { HOME: '/tmp', CI: '1', npm_config_cache: '/tmp/.npm', ...env },
      limits,
      network,
      user: this.options.user ?? '1000:1000',
    });
    const options = {
      cwd: workspace.root,
      env: clientEnv,
      maxOutputBytes: this.options.maxOutputBytes ?? 1024 * 1024,
    };
    try {
      const result = await runProcess(docker, args, {
        ...options,
        timeoutMs: limits.timeoutMs,
        signal,
      });
      if (result.exitCode === 125 && /No such image|pull access denied/i.test(result.stderr))
        throw new OperationFailure('SANDBOX_IMAGE_UNAVAILABLE', `Image ${image} is not present.`);
      return result;
    } finally {
      // Killing the docker client does not stop the container; remove it explicitly.
      await runProcess(docker, ['rm', '--force', name], { ...options, timeoutMs: 30_000 });
    }
  }
}
