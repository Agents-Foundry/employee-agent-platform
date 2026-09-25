import type {
  ArtifactRegistration,
  RuntimeCorrelation,
  SignedAgentManifestV2,
} from '@agents-foundry/contracts';
import type { ArtifactStore } from './artifact-store.js';

export interface ToolExecutionContext {
  correlation: RuntimeCorrelation & { stepId: string; toolCallId: string };
  manifest: SignedAgentManifestV2;
  artifacts: ArtifactStore;
  /** Registers an artifact with the control plane (`artifact.created`) before it is referenced. */
  registerArtifact(artifact: ArtifactRegistration): Promise<void>;
  signal: AbortSignal;
}

export interface ToolOutput {
  /** Text returned to the model. Only its digest leaves the runtime. */
  output: string;
  artifactIds: string[];
}

/**
 * A runtime tool implementation. Its id and version must match the catalog tool definition
 * pinned by the manifest; the control plane rejects governed actions otherwise.
 */
export interface RuntimeTool<Input = unknown> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Throws on invalid input; the model sees a validation error, nothing executes. */
  parse(input: unknown): Input;
  /** The governed action this invocation performs, or null for ungoverned local work. */
  governedAction(input: Input): string | null;
  /** Purpose shown to a human approver. Must not contain secrets. */
  summarize(input: Input): string;
  execute(input: Input, context: ToolExecutionContext): Promise<ToolOutput>;
}

/** Implementations available in this runtime; a manifest can only narrow this set. */
export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  constructor(tools: readonly RuntimeTool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.id)) throw new Error('DUPLICATE_RUNTIME_TOOL');
      this.tools.set(tool.id, tool);
    }
  }

  /** Tools the manifest grants and this runtime implements. Anything else is never offered. */
  forManifest(manifest: SignedAgentManifestV2): RuntimeTool[] {
    return manifest.payload.tools.flatMap((id) => {
      const tool = this.tools.get(id);
      return tool ? [tool] : [];
    });
  }
}
