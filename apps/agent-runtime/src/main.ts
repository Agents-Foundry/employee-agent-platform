import { ControlPlaneCheckpointStore, FileCheckpointStore } from './checkpoints.js';
import { loadRuntimeConfig, statePaths } from './config.js';
import { NativeKernel } from './kernel/native-kernel.js';
import { ManifestVerifier } from './manifest-verifier.js';
import { AnthropicProvider } from './models/anthropic-provider.js';
import {
  ControlPlaneModelCredentials,
  EnvironmentCredentialBroker,
  FirstAvailableCredentials,
  ModelGateway,
} from './models/model-gateway.js';
import { RUNTIME_PROTOCOL_V1 } from '../../../packages/contracts/src/runtime/v1/protocol.js';
import { ScriptedProvider } from './models/scripted-provider.js';
import { consoleLogger, RuntimeHost } from './runtime-host.js';
import { ArtifactTool } from './tools/artifact-tool.js';
import { IssueTrackerTool } from './tools/issue-tracker-tool.js';
import { SourceControlTool } from './tools/source-control-tool.js';
import { ControlPlaneArtifactStore, LocalArtifactStore } from './tools/artifact-store.js';
import { ToolRegistry } from './tools/runtime-tool.js';
import { ControlPlaneClient } from './transport/control-plane-client.js';
import { ExecutionClient } from './transport/execution-client.js';
import {
  BrowserTool,
  BuildTool,
  CodeEditorTool,
  DependencyTool,
  RepositoryTool,
} from './tools/execution-tools.js';

const config = loadRuntimeConfig();
const paths = statePaths(config.stateDir);
const providers = [
  new AnthropicProvider(),
  ...(config.enableScriptedModel ? [ScriptedProvider.demo()] : []),
];
const controlPlane = new ControlPlaneClient({
  baseUrl: config.controlPlaneUrl,
  runtimeId: config.runtimeId,
  privateKey: config.privateKey,
});
const environmentKeys = new EnvironmentCredentialBroker();
const host = new RuntimeHost({
  controlPlane,
  verifier: new ManifestVerifier(config.manifestVerificationKey),
  kernel: new NativeKernel(),
  // Calls are made with the per-run broker below; this one is never the default path.
  models: new ModelGateway(providers, {
    resolve: async () => {
      throw new Error('MODEL_CREDENTIAL_UNAVAILABLE');
    },
  }),
  // The organization's key comes from the control plane's secret broker for each call.
  modelCredentials: (correlation) => {
    const managed = new ControlPlaneModelCredentials(async (provider) => {
      const credential = await controlPlane.modelCredential({
        protocol: RUNTIME_PROTOCOL_V1,
        correlation,
        provider,
      });
      return { apiKey: credential.apiKey };
    });
    return config.allowEnvironmentModelKeys
      ? new FirstAvailableCredentials([managed, environmentKeys])
      : managed;
  },
  tools: new ToolRegistry([
    new ArtifactTool(),
    new IssueTrackerTool(),
    new SourceControlTool(),
    // Workspace work (repository, browser, editing, builds, installs) runs only in an
    // execution runtime.
    ...(config.executionRuntimeUrl
      ? [
          new RepositoryTool(new ExecutionClient(config.executionRuntimeUrl)),
          new BrowserTool(new ExecutionClient(config.executionRuntimeUrl)),
          new CodeEditorTool(new ExecutionClient(config.executionRuntimeUrl)),
          new BuildTool(new ExecutionClient(config.executionRuntimeUrl)),
          new DependencyTool(new ExecutionClient(config.executionRuntimeUrl)),
        ]
      : []),
  ]),
  artifacts:
    config.artifactStore === 'local'
      ? new LocalArtifactStore(paths.artifacts)
      : new ControlPlaneArtifactStore(controlPlane),
  checkpoints:
    config.checkpointStore === 'local'
      ? new FileCheckpointStore(paths.checkpoints)
      : new ControlPlaneCheckpointStore(controlPlane),
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  concurrency: config.concurrency,
  pollIntervalMs: config.pollIntervalMs,
});

consoleLogger.info('agent runtime started', {
  runtimeId: config.runtimeId,
  checkpointStore: config.checkpointStore,
  providers: providers.map((provider) => provider.id),
});
void host.start();

function shutdown(signal: string): void {
  consoleLogger.info('agent runtime stopping', { signal });
  void host.stop().then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
