import { existsSync } from 'node:fs';
import { mkdir, open, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ExecutionOperation, ResourceLimits } from '@agents-foundry/contracts';
import { runProcess, type ProcessResult } from '../process-runner.js';
import type {
  ExecutionProvider,
  ProducedArtifact,
  ProviderOutcome,
  WorkspaceHandle,
} from './execution-provider.js';

export interface LocalProviderOptions {
  /** Allow `file://` repositories (tests and air-gapped mirrors). Off by default. */
  allowFileRepositories?: boolean;
  gitExecutable?: string;
  nodeExecutable?: string;
  maxOutputBytes?: number;
  maxFileBytes?: number;
}

const MODEL_OUTPUT_LIMIT = 20_000;

class OperationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Resolve a validated workspace-relative path and prove, after symlinks, it stays inside. */
async function inside(root: string, relative: string, mustExist: boolean): Promise<string> {
  const target = resolve(root, ...relative.split('/').filter((part) => part !== '.'));
  const contained = (path: string, base: string) => path === base || path.startsWith(base + sep);
  if (!contained(target, root)) throw new OperationFailure('PATH_OUTSIDE_WORKSPACE', relative);
  if (!mustExist) return target;
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new OperationFailure('PATH_NOT_FOUND', `${relative} does not exist.`);
  }
  if (!contained(real, await realpath(root)))
    throw new OperationFailure(
      'PATH_OUTSIDE_WORKSPACE',
      `${relative} resolves outside the workspace.`,
    );
  return real;
}

function bounded(text: string): { output: string; truncated: boolean } {
  return text.length > MODEL_OUTPUT_LIMIT
    ? { output: text.slice(0, MODEL_OUTPUT_LIMIT), truncated: true }
    : { output: text, truncated: false };
}

/**
 * Development and single-tenant provider: runs tools as the runtime's OS user on the host.
 * It enforces workspace path confinement, a scrubbed environment, argument vectors (no shell),
 * wall-clock timeouts with process-tree kill and output caps. It does **not** enforce CPU,
 * memory, process-count or network limits, so it reports `isolation: 'local'` and sandboxed
 * grants are refused unless an operator explicitly accepts that (ADR 0013).
 */
export class LocalExecutionProvider implements ExecutionProvider {
  readonly id = 'local';
  readonly isolation = 'local' as const;
  readonly enforces = ['timeout', 'output', 'filesystem', 'environment'] as const;

  constructor(private readonly options: LocalProviderOptions = {}) {}

  async execute(
    workspace: WorkspaceHandle,
    operation: ExecutionOperation,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    try {
      switch (operation.kind) {
        case 'git.checkout':
          return await this.checkout(workspace, operation, limits, signal);
        case 'git.status':
          return await this.status(workspace, operation.path, limits, signal);
        case 'file.read':
          return await this.read(workspace, operation.path);
        case 'playwright.run':
          return await this.playwright(workspace, operation, limits, signal);
        default:
          return {
            status: 'DENIED',
            error: {
              code: 'OPERATION_NOT_SUPPORTED',
              message: `${operation.kind} is not supported by the local provider.`,
            },
            output: '',
            truncated: false,
            artifacts: [],
          };
      }
    } catch (error) {
      if (error instanceof OperationFailure)
        return {
          status: 'FAILED',
          error: { code: error.code, message: error.message.slice(0, 500) },
          output: '',
          truncated: false,
          artifacts: [],
        };
      throw error;
    }
  }

  private async environment(workspace: WorkspaceHandle, extra: Record<string, string> = {}) {
    const home = join(workspace.scratch, 'home');
    const tmp = join(workspace.scratch, 'tmp');
    await mkdir(home, { recursive: true });
    await mkdir(tmp, { recursive: true });
    const gitConfig = join(workspace.scratch, 'gitconfig');
    if (!existsSync(gitConfig)) await writeFile(gitConfig, '');
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      USERPROFILE: home,
      TMP: tmp,
      TEMP: tmp,
      TMPDIR: tmp,
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitConfig,
      ...extra,
    };
    // Windows needs these to load system libraries and networking; they hold no secrets.
    for (const name of ['SystemRoot', 'WINDIR', 'SYSTEMROOT'])
      if (process.env[name]) env[name] = process.env[name]!;
    return env;
  }

  private async git(
    workspace: WorkspaceHandle,
    args: string[],
    cwd: string,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProcessResult> {
    const hooks = join(workspace.scratch, 'no-hooks');
    await mkdir(hooks, { recursive: true });
    const safety = [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'credential.helper=',
      '-c',
      `protocol.file.allow=${this.options.allowFileRepositories ? 'always' : 'never'}`,
      '-c',
      'core.symlinks=false',
    ];
    return runProcess(this.options.gitExecutable ?? 'git', [...safety, ...args], {
      cwd,
      env: await this.environment(workspace),
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes ?? 1024 * 1024,
      signal,
    });
  }

  private failedProcess(result: ProcessResult, code: string, what: string): ProviderOutcome {
    const logs = this.logs(result, `${code.toLowerCase()}.log`);
    return {
      status: result.timedOut ? 'TIMED_OUT' : 'FAILED',
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      error: {
        code: result.timedOut ? 'OPERATION_TIMED_OUT' : code,
        message: `${what} ${result.timedOut ? 'timed out' : `exited with ${result.exitCode}`}.`,
      },
      ...bounded(result.stderr.trim() || result.stdout.trim()),
      artifacts: logs,
    };
  }

  private logs(result: ProcessResult, name: string): ProducedArtifact[] {
    const text = [
      result.stdout && `stdout:\n${result.stdout}`,
      result.stderr && `stderr:\n${result.stderr}`,
    ]
      .filter(Boolean)
      .join('\n');
    return text
      ? [{ name, type: 'log', mediaType: 'text/plain', content: Buffer.from(text, 'utf8') }]
      : [];
  }

  private async checkout(
    workspace: WorkspaceHandle,
    operation: Extract<ExecutionOperation, { kind: 'git.checkout' }>,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const url = new URL(operation.repositoryUrl);
    if (url.protocol === 'file:' && !this.options.allowFileRepositories)
      throw new OperationFailure(
        'REPOSITORY_PROTOCOL_FORBIDDEN',
        'file:// repositories are disabled.',
      );
    const target = await inside(workspace.root, operation.path, false);
    if (existsSync(target))
      throw new OperationFailure('PATH_ALREADY_EXISTS', `${operation.path} already exists.`);
    const template = join(workspace.scratch, 'empty-template');
    await mkdir(template, { recursive: true });
    const clone = await this.git(
      workspace,
      [
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--no-tags',
        `--template=${template}`,
        '--branch',
        operation.ref,
        '--',
        operation.repositoryUrl,
        target,
      ],
      workspace.root,
      limits,
      signal,
    );
    if (clone.exitCode !== 0 || clone.timedOut)
      return this.failedProcess(clone, 'GIT_CHECKOUT_FAILED', 'git clone');
    const head = await this.git(workspace, ['rev-parse', 'HEAD'], target, limits, signal);
    const commit = head.stdout.trim();
    return {
      status: 'SUCCEEDED',
      exitCode: 0,
      output: `Checked out ${operation.ref} of ${operation.repositoryUrl} into ${operation.path} at ${commit}.`,
      truncated: false,
      artifacts: this.logs(clone, 'git-checkout.log'),
    };
  }

  private async status(
    workspace: WorkspaceHandle,
    path: string,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const directory = await inside(workspace.root, path, true);
    const result = await this.git(
      workspace,
      ['status', '--porcelain=v1', '--branch'],
      directory,
      limits,
      signal,
    );
    if (result.exitCode !== 0 || result.timedOut)
      return this.failedProcess(result, 'GIT_STATUS_FAILED', 'git status');
    return { status: 'SUCCEEDED', exitCode: 0, ...bounded(result.stdout), artifacts: [] };
  }

  private async read(workspace: WorkspaceHandle, path: string): Promise<ProviderOutcome> {
    const file = await inside(workspace.root, path, true);
    const info = await stat(file);
    if (!info.isFile()) throw new OperationFailure('NOT_A_FILE', `${path} is not a file.`);
    const limit = this.options.maxFileBytes ?? 256 * 1024;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, limit));
      await handle.read(buffer, 0, buffer.byteLength, 0);
      if (buffer.includes(0))
        throw new OperationFailure('BINARY_FILE', `${path} is not a text file.`);
      return {
        status: 'SUCCEEDED',
        output: buffer.toString('utf8'),
        truncated: info.size > limit,
        artifacts: [],
      };
    } finally {
      await handle.close();
    }
  }

  private async playwright(
    workspace: WorkspaceHandle,
    operation: Extract<ExecutionOperation, { kind: 'playwright.run' }>,
    limits: ResourceLimits,
    signal: AbortSignal,
  ): Promise<ProviderOutcome> {
    const directory = await inside(workspace.root, operation.path ?? '.', true);
    let cli: string;
    try {
      cli = await inside(
        workspace.root,
        [operation.path ?? '.', 'node_modules/@playwright/test/cli.js']
          .join('/')
          .replace(/^\.\//, ''),
        true,
      );
    } catch {
      throw new OperationFailure(
        'PLAYWRIGHT_NOT_INSTALLED',
        'The project has no installed @playwright/test; dependency installation is not supported yet.',
      );
    }
    const result = await runProcess(
      this.options.nodeExecutable ?? process.execPath,
      [cli, 'test', `--project=${operation.project}`, '--reporter=json'],
      {
        cwd: directory,
        env: await this.environment(workspace, {
          BASE_URL: operation.baseUrl,
          PLAYWRIGHT_BASE_URL: operation.baseUrl,
        }),
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: this.options.maxOutputBytes ?? 1024 * 1024,
        signal,
      },
    );
    if (result.timedOut) return this.failedProcess(result, 'PLAYWRIGHT_FAILED', 'Playwright');
    let stats: { expected?: number; unexpected?: number; flaky?: number; skipped?: number } = {};
    try {
      stats = (JSON.parse(result.stdout) as { stats?: typeof stats }).stats ?? {};
    } catch {
      return this.failedProcess(result, 'PLAYWRIGHT_REPORT_INVALID', 'Playwright');
    }
    const summary =
      `Playwright project ${operation.project} against ${new URL(operation.baseUrl).origin}: ` +
      `${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, ` +
      `${stats.flaky ?? 0} flaky, ${stats.skipped ?? 0} skipped.`;
    const artifacts: ProducedArtifact[] = [
      {
        name: 'playwright-report.json',
        type: 'test_report',
        mediaType: 'application/json',
        content: Buffer.from(result.stdout, 'utf8'),
      },
      ...(result.stderr ? this.logs({ ...result, stdout: '' }, 'playwright-stderr.log') : []),
    ];
    const failed = result.exitCode !== 0 || (stats.unexpected ?? 0) > 0;
    return {
      status: failed ? 'FAILED' : 'SUCCEEDED',
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      ...(failed ? { error: { code: 'PLAYWRIGHT_TESTS_FAILED', message: summary } } : {}),
      output: summary,
      truncated: result.truncated,
      artifacts,
    };
  }
}
