import { join } from 'node:path';
import { ExecutionArtifactStore } from './artifact-store.js';
import { ExecutionService } from './execution-service.js';
import { GrantVerifier } from './grant-verifier.js';
import { LocalExecutionProvider } from './providers/local-provider.js';
import { createExecutionServer } from './server.js';
import { StateStore } from './state-store.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const root = process.env['EXECUTION_RUNTIME_STATE_DIR'] ?? '.data/execution-runtime';
const host = process.env['EXECUTION_RUNTIME_HOST'] ?? '127.0.0.1';
const port = Number(process.env['EXECUTION_RUNTIME_PORT'] ?? 4500);
const provider = new LocalExecutionProvider({
  allowFileRepositories: process.env['EXECUTION_ALLOW_FILE_REPOSITORIES'] === 'true',
});
const state = new StateStore(join(root, 'state.db'));
const service = new ExecutionService({
  verifier: new GrantVerifier(required('EXECUTION_GRANT_VERIFICATION_KEY')),
  provider,
  state,
  artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
  workspaceRoot: root,
  allowUnsandboxed: process.env['EXECUTION_ALLOW_UNSANDBOXED'] === 'true',
});
const server = createExecutionServer(service, provider).listen(port, host, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'execution runtime listening',
      host,
      port,
      provider: provider.id,
    }),
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', message: 'execution runtime stopping', signal }));
  server.close(() => {
    state.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
