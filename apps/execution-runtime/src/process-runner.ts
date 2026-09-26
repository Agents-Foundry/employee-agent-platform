import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Output beyond the cap was discarded. */
  truncated: boolean;
  durationMs: number;
}

export interface ProcessOptions {
  cwd: string;
  /** The complete environment. Nothing is inherited from the execution runtime's own process. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** Terminates the whole process tree: children of `git` or test runners must not survive. */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* The process already exited. */
  }
}

/**
 * Runs one executable with an argument vector (never a shell string), a scrubbed environment,
 * a wall-clock timeout that kills the process tree, and capped output capture.
 */
export function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = options.maxOutputBytes - captured;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      if (kept !== chunk) truncated = true;
      chunks[stream].push(kept);
      captured += kept.byteLength;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const stop = () => {
      if (child.pid !== undefined && child.exitCode === null) killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', stop, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      resolve({
        exitCode,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}
