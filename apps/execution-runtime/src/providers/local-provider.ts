import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ExecutionOperation, ResourceLimits } from '@agents-foundry/contracts';
import { runProcess, type ProcessResult } from '../process-runner.js';
import { startLocalEgressProxy, type EgressOverrides, type LocalEgressProxy } from './egress.js';
import {
  EVIDENCE_RETENTION,
  collectPlaywrightEvidence,
  type CollectedEvidence,
} from './playwright-evidence.js';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionProvider,
  OperationContext,
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
  /** A CA bundle git also trusts for HTTPS hosts (an enterprise git host's private CA). */
  gitCaFile?: string;
  /** Test seams for the egress proxy that every HTTPS checkout goes through. */
  egress?: EgressOverrides;
}

const MODEL_OUTPUT_LIMIT = 20_000;

export class OperationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const contained = (path: string, base: string) => path === base || path.startsWith(base + sep);

/** Resolve a validated workspace-relative path and prove, after symlinks, it stays inside. */
export async function inside(root: string, relative: string, mustExist: boolean): Promise<string> {
  const target = resolve(root, ...relative.split('/').filter((part) => part !== '.'));
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

export function bounded(text: string): { output: string; truncated: boolean } {
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
    context: OperationContext = {},
  ): Promise<ProviderOutcome> {
    try {
      // A credential is redeemed for one checkout and is never offered to anything else.
      if (context.credential && operation.kind !== 'git.checkout')
        throw new OperationFailure('CREDENTIAL_OPERATION_FORBIDDEN', '');
      switch (operation.kind) {
        case 'git.checkout':
          return await this.checkout(workspace, operation, limits, signal, context);
        case 'git.status':
          return await this.status(workspace, operation.path, limits, signal);
        case 'file.read':
          return await this.read(workspace, operation.path);
        case 'file.write':
          return await this.write(workspace, operation.path, operation.content);
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
    extraEnv: Record<string, string> = {},
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
      env: await this.environment(workspace, extraEnv),
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes ?? 1024 * 1024,
      signal,
    });
  }

  /**
   * Clone one branch or tag. HTTPS clones leave only through the egress proxy, limited to the
   * grant's hosts, and never follow redirects. A brokered credential (ADR 0031) is sent only
   * as an `Authorization` header on requests to this exact repository URL: it is passed to git
   * in the child process environment, never in the URL, a config file, a credential helper or
   * the command line, so nothing of it remains in the workspace. Submodules are never fetched.
   * A failed, timed-out or cancelled clone leaves no partial checkout behind.
   */
  private async checkout(
    workspace: WorkspaceHandle,
    operation: Extract<ExecutionOperation, { kind: 'git.checkout' }>,
    limits: ResourceLimits,
    signal: AbortSignal,
    context: OperationContext,
  ): Promise<ProviderOutcome> {
    const url = new URL(operation.repositoryUrl);
    const { credential } = context;
    if (url.protocol === 'file:' && !this.options.allowFileRepositories)
      throw new OperationFailure(
        'REPOSITORY_PROTOCOL_FORBIDDEN',
        'file:// repositories are disabled.',
      );
    if (credential && url.protocol !== 'https:')
      throw new OperationFailure('CREDENTIAL_PROTOCOL_FORBIDDEN', 'Credentials need HTTPS.');
    const target = await inside(workspace.root, operation.path, false);
    if (existsSync(target))
      throw new OperationFailure('PATH_ALREADY_EXISTS', `${operation.path} already exists.`);
    const template = join(workspace.scratch, 'empty-template');
    await mkdir(template, { recursive: true });
    const secrets = credential?.secrets() ?? [];
    const network: string[] = [];
    const env: Record<string, string> = {};
    let proxy: LocalEgressProxy | undefined;
    let clone: ProcessResult;
    try {
      if (url.protocol === 'https:') {
        proxy = await startLocalEgressProxy(
          limits.network.mode === 'ALLOW_LIST' ? limits.network.allowedHosts : [],
          this.options.egress,
        );
        network.push(
          '-c',
          `http.proxy=${proxy.url}`,
          '-c',
          'http.followRedirects=false',
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'submodule.recurse=false',
          ...(this.options.gitCaFile ? ['-c', `http.sslCAInfo=${this.options.gitCaFile}`] : []),
        );
      }
      if (credential) {
        if (credential.expiresAt <= Date.now())
          throw new OperationFailure('CREDENTIAL_EXPIRED', 'The credential lease expired.');
        const { username, password } = credential.reveal();
        const basic = Buffer.from(`${username}:${password}`).toString('base64');
        env['GIT_CONFIG_COUNT'] = '1';
        env['GIT_CONFIG_KEY_0'] = `http.${operation.repositoryUrl}.extraHeader`;
        env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`;
      }
      clone = redacted(
        await this.git(
          workspace,
          [
            ...network,
            'clone',
            '--depth',
            '1',
            '--single-branch',
            '--no-tags',
            '--no-recurse-submodules',
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
          env,
        ),
        secrets,
      );
    } finally {
      await proxy?.close();
    }
    const discard = () => rm(target, { recursive: true, force: true, maxRetries: 3 });
    if (clone.exitCode !== 0 || clone.timedOut || signal.aborted) {
      await discard();
      const failure = failedProcess(clone, 'GIT_CHECKOUT_FAILED', 'git clone');
      if (proxy) failure.measurements = { egressDenied: proxy.denied.length };
      if (proxy?.denied.length && failure.error && !clone.timedOut)
        failure.error = {
          code: 'EGRESS_DENIED',
          message: `The checkout tried to reach a host the grant does not allow: ${proxy.denied[0]}.`,
        };
      return failure;
    }
    if (credential) {
      // Belt and braces: nothing of the credential may have reached the repository's config.
      const config = await readFile(join(target, '.git', 'config'), 'utf8').catch(() => '');
      if (secrets.some((secret) => config.includes(secret)) || /extraheader/i.test(config)) {
        await discard();
        throw new OperationFailure('CREDENTIAL_PERSISTED', 'The checkout was discarded.');
      }
    }
    const head = await this.git(workspace, ['rev-parse', 'HEAD'], target, limits, signal);
    const commit = head.stdout.trim();
    const submodules = existsSync(join(target, '.gitmodules'))
      ? ' Its submodules were not fetched: submodule checkout is not supported.'
      : '';
    return {
      status: 'SUCCEEDED',
      exitCode: 0,
      output: `Checked out ${operation.ref} of ${operation.repositoryUrl} into ${operation.path} at ${commit}.${submodules}`,
      truncated: false,
      artifacts: processLogs(clone, 'git-checkout.log'),
      ...(proxy ? { measurements: { egressDenied: proxy.denied.length } } : {}),
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
      return failedProcess(result, 'GIT_STATUS_FAILED', 'git status');
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

  /**
   * Write text inside the workspace. The deepest existing ancestor is resolved through symlinks
   * and must stay inside the workspace before any directory is created, and an existing
   * symlink is never written through.
   */
  private async write(
    workspace: WorkspaceHandle,
    path: string,
    content: string,
  ): Promise<ProviderOutcome> {
    const target = await inside(workspace.root, path, false);
    const root = await realpath(workspace.root);
    let ancestor = dirname(target);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!contained(await realpath(ancestor), root))
      throw new OperationFailure(
        'PATH_OUTSIDE_WORKSPACE',
        `${path} resolves outside the workspace.`,
      );
    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isFile())
      throw new OperationFailure('NOT_A_FILE', `${path} exists and is not a regular file.`);
    await mkdir(dirname(target), { recursive: true });
    if (!contained(await realpath(dirname(target)), root))
      throw new OperationFailure(
        'PATH_OUTSIDE_WORKSPACE',
        `${path} resolves outside the workspace.`,
      );
    const bytes = Buffer.from(content, 'utf8');
    await writeFile(target, bytes);
    return {
      status: 'SUCCEEDED',
      output: `${existing ? 'Updated' : 'Created'} ${path} (${bytes.byteLength} bytes).`,
      truncated: false,
      artifacts: [],
    };
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
        'The project has no installed @playwright/test; the local provider cannot install dependencies.',
      );
    }
    const evidence = playwrightEvidenceDirectory();
    try {
      const result = await runProcess(
        this.options.nodeExecutable ?? process.execPath,
        [cli, 'test', ...playwrightArguments(operation, evidence)],
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
      return playwrightOutcome(
        result,
        operation,
        await collectPlaywrightEvidence(join(directory, evidence)),
      );
    } finally {
      await rm(join(directory, evidence), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** A fresh directory name for one run's Playwright output, inside the project directory. */
export function playwrightEvidenceDirectory(): string {
  return `.af-playwright-${randomUUID()}`;
}

/**
 * The Playwright arguments of every run: the JSON report on standard output, attachments in
 * the run's own output directory, and a trace kept for each test that fails.
 */
export function playwrightArguments(
  operation: Extract<ExecutionOperation, { kind: 'playwright.run' }>,
  evidenceDirectory: string,
): string[] {
  return [
    `--project=${operation.project}`,
    '--reporter=json',
    `--output=${evidenceDirectory}`,
    '--trace=retain-on-failure',
  ];
}

/** Replace every occurrence of each secret; longest first so no fragment survives. */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) result = result.split(secret).join('[REDACTED]');
  return result;
}

function redacted(result: ProcessResult, secrets: readonly string[]): ProcessResult {
  return secrets.length
    ? { ...result, stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) }
    : result;
}

/** Collect a process's output as a log artifact (none when it printed nothing). */
export function processLogs(result: ProcessResult, name: string): ProducedArtifact[] {
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

/** Outcome of a process that failed or timed out, with its output kept as evidence. */
export function failedProcess(result: ProcessResult, code: string, what: string): ProviderOutcome {
  return {
    status: result.timedOut ? 'TIMED_OUT' : 'FAILED',
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    error: {
      code: result.timedOut ? 'OPERATION_TIMED_OUT' : code,
      message: `${what} ${result.timedOut ? 'timed out' : `exited with ${result.exitCode}`}.`,
    },
    ...bounded(result.stderr.trim() || result.stdout.trim()),
    artifacts: processLogs(result, `${code.toLowerCase()}.log`),
  };
}

/** Interpret a `--reporter=json` Playwright run, wherever it ran. */
export function playwrightOutcome(
  result: ProcessResult,
  operation: Extract<ExecutionOperation, { kind: 'playwright.run' }>,
  evidence: CollectedEvidence = { artifacts: [], omitted: 0 },
): ProviderOutcome {
  // Whatever the browser left behind is evidence, also of a run that timed out or crashed.
  const collected = (outcome: ProviderOutcome): ProviderOutcome => ({
    ...outcome,
    artifacts: [...outcome.artifacts, ...evidence.artifacts],
  });
  if (result.timedOut) return collected(failedProcess(result, 'PLAYWRIGHT_FAILED', 'Playwright'));
  let stats: { expected?: number; unexpected?: number; flaky?: number; skipped?: number } = {};
  try {
    stats = (JSON.parse(result.stdout) as { stats?: typeof stats }).stats ?? {};
  } catch {
    return collected(failedProcess(result, 'PLAYWRIGHT_REPORT_INVALID', 'Playwright'));
  }
  const count = (type: ProducedArtifact['type']) =>
    evidence.artifacts.filter((artifact) => artifact.type === type).length;
  const kept = [
    [count('playwright_trace'), 'trace'],
    [count('screenshot'), 'screenshot'],
    [count('video'), 'video'],
  ]
    .filter(([number]) => Number(number) > 0)
    .map(([number, label]) => `${number} ${label}${number === 1 ? '' : 's'}`);
  const summary =
    `Playwright project ${operation.project} against ${new URL(operation.baseUrl).origin}: ` +
    `${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, ` +
    `${stats.flaky ?? 0} flaky, ${stats.skipped ?? 0} skipped.`;
  const note =
    (kept.length ? ` Evidence stored: ${kept.join(', ')}.` : '') +
    (evidence.omitted
      ? ` ${evidence.omitted} evidence file(s) were over the size or count limits and were not kept.`
      : '');
  const artifacts: ProducedArtifact[] = [
    {
      name: 'playwright-report.json',
      type: 'test_report',
      mediaType: 'application/json',
      content: Buffer.from(result.stdout, 'utf8'),
      retention: EVIDENCE_RETENTION.test_report,
    },
    // What the test process itself printed; the browser's console is inside each trace.
    ...(result.stderr
      ? [
          {
            name: 'playwright-console.log',
            type: 'console_log' as const,
            mediaType: 'text/plain',
            content: Buffer.from(result.stderr, 'utf8'),
            retention: EVIDENCE_RETENTION.console_log,
          },
        ]
      : []),
  ];
  const failed = result.exitCode !== 0 || (stats.unexpected ?? 0) > 0;
  return collected({
    status: failed ? 'FAILED' : 'SUCCEEDED',
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(failed ? { error: { code: 'PLAYWRIGHT_TESTS_FAILED', message: summary } } : {}),
    output: summary + note,
    truncated: result.truncated,
    artifacts,
  });
}
