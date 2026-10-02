import { join } from 'node:path';
import { ExecutionArtifactStore } from './artifact-store.js';
import { ControlPlaneCredentialClient } from './credential-client.js';
import { ExecutionService } from './execution-service.js';
import { GrantVerifier } from './grant-verifier.js';
import {
  ContainerExecutionProvider,
  defaultEgressProxyDirectory,
} from './providers/container-provider.js';
import type { ExecutionProvider } from './providers/execution-provider.js';
import { LocalExecutionProvider } from './providers/local-provider.js';
import { createExecutionServer } from './server.js';
import { StateStore } from './state-store.js';
import { telemetryFromEnvironment } from '../../../packages/telemetry/src/index.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const root = process.env['EXECUTION_RUNTIME_STATE_DIR'] ?? '.data/execution-runtime';
const host = process.env['EXECUTION_RUNTIME_HOST'] ?? '127.0.0.1';
const port = Number(process.env['EXECUTION_RUNTIME_PORT'] ?? 4500);
const hostOptions = {
  allowFileRepositories: process.env['EXECUTION_ALLOW_FILE_REPOSITORIES'] === 'true',
  ...(process.env['EXECUTION_GIT_CA_FILE']
    ? { gitCaFile: process.env['EXECUTION_GIT_CA_FILE'] }
    : {}),
};
const providerId = process.env['EXECUTION_PROVIDER'] ?? 'local';
if (providerId !== 'local' && providerId !== 'container')
  throw new Error('EXECUTION_PROVIDER_UNKNOWN');
/** Container provider only: the allow-list egress proxy (ADR 0016), on unless disabled. */
function egressProxy(): Record<string, string> {
  if (process.env['EXECUTION_EGRESS_PROXY'] === 'false') return {};
  const directory =
    process.env['EXECUTION_EGRESS_PROXY_DIR']?.trim() || defaultEgressProxyDirectory();
  if (!directory) throw new Error('EXECUTION_EGRESS_PROXY_NOT_FOUND');
  return {
    egressProxyDirectory: directory,
    ...(process.env['EXECUTION_EGRESS_PROXY_IMAGE']
      ? { egressProxyImage: process.env['EXECUTION_EGRESS_PROXY_IMAGE'] }
      : {}),
  };
}
const provider: ExecutionProvider =
  providerId === 'container'
    ? new ContainerExecutionProvider({
        ...hostOptions,
        image: required('EXECUTION_SANDBOX_IMAGE'),
        ...(process.env['EXECUTION_PLAYWRIGHT_IMAGE']
          ? { playwrightImage: process.env['EXECUTION_PLAYWRIGHT_IMAGE'] }
          : {}),
        ...egressProxy(),
        allowUnrestrictedEgress: process.env['EXECUTION_ALLOW_UNRESTRICTED_EGRESS'] === 'true',
      })
    : new LocalExecutionProvider(hostOptions);
const state = new StateStore(join(root, 'state.db'));
const credentials = ControlPlaneCredentialClient.fromEnvironment();
// ADR 0035: traces and metrics for this process.
const observability = telemetryFromEnvironment('execution-runtime');
const stopTelemetry = observability.start();
const metricsTokenPath = process.env['EXECUTION_METRICS_TOKEN_PATH']?.trim();
const service = new ExecutionService({
  telemetry: observability.telemetry,
  verifier: new GrantVerifier(required('EXECUTION_GRANT_VERIFICATION_KEY')),
  provider,
  state,
  artifacts: new ExecutionArtifactStore(join(root, 'artifacts')),
  workspaceRoot: root,
  allowUnsandboxed: process.env['EXECUTION_ALLOW_UNSANDBOXED'] === 'true',
  // With an identity, evidence goes to the control plane's artifact store as well.
  ...(credentials ? { credentials, evidence: credentials } : {}),
});
// Checkouts a previous process left unfinished are discarded and their leases ended.
const recovered = await service.recover();
const server = createExecutionServer(
  service,
  provider,
  metricsTokenPath
    ? { telemetry: observability.telemetry, tokenPath: metricsTokenPath }
    : undefined,
).listen(port, host, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'execution runtime listening',
      host,
      port,
      provider: provider.id,
      authenticatedCheckout: credentials !== undefined,
      durableEvidence: credentials !== undefined,
      recoveredCheckouts: recovered,
    }),
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', message: 'execution runtime stopping', signal }));
  server.close(() => {
    state.close();
    void stopTelemetry().finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
