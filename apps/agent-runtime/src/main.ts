import { FileCheckpointStore } from './checkpoints.js';
import { loadRuntimeConfig, statePaths } from './config.js';
import { NativeKernel } from './kernel/native-kernel.js';
import { ManifestVerifier } from './manifest-verifier.js';
import { AnthropicProvider } from './models/anthropic-provider.js';
import { EnvironmentCredentialBroker, ModelGateway } from './models/model-gateway.js';
import { ScriptedProvider } from './models/scripted-provider.js';
import { consoleLogger, RuntimeHost } from './runtime-host.js';
import { ArtifactTool } from './tools/artifact-tool.js';
import { IssueTrackerTool } from './tools/issue-tracker-tool.js';
import { LocalArtifactStore } from './tools/artifact-store.js';
import { ToolRegistry } from './tools/runtime-tool.js';
import { ControlPlaneClient } from './transport/control-plane-client.js';

const config = loadRuntimeConfig();
const paths = statePaths(config.stateDir);
const providers = [
  new AnthropicProvider(),
  ...(config.enableScriptedModel ? [ScriptedProvider.demo()] : []),
];
const host = new RuntimeHost({
  controlPlane: new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    runtimeId: config.runtimeId,
    privateKey: config.privateKey,
  }),
  verifier: new ManifestVerifier(config.manifestVerificationKey),
  kernel: new NativeKernel(),
  models: new ModelGateway(providers, new EnvironmentCredentialBroker()),
  tools: new ToolRegistry([new ArtifactTool(), new IssueTrackerTool()]),
  artifacts: new LocalArtifactStore(paths.artifacts),
  checkpoints: new FileCheckpointStore(paths.checkpoints),
  concurrency: config.concurrency,
  pollIntervalMs: config.pollIntervalMs,
});

consoleLogger.info('agent runtime started', {
  runtimeId: config.runtimeId,
  providers: providers.map((provider) => provider.id),
});
void host.start();

function shutdown(signal: string): void {
  consoleLogger.info('agent runtime stopping', { signal });
  void host.stop().then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
