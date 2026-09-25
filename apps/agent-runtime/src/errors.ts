import type { ExecutionError } from '@agents-foundry/contracts';

/** A failure the runtime reports on the run (`run.failed` / `tool.failed`). Never carries secrets. */
export class RuntimeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }

  toExecutionError(): ExecutionError {
    return { code: this.code, message: this.message.slice(0, 2000) };
  }
}

/** The control plane rejected a request. 4xx responses are final; retrying cannot help. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }

  get final(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export function asRuntimeFailure(error: unknown): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  if (error instanceof ControlPlaneError)
    return new RuntimeFailure('CONTROL_PLANE_REJECTED', error.code, !error.final);
  return new RuntimeFailure('RUNTIME_INTERNAL_ERROR', 'The runtime failed unexpectedly.', true);
}
