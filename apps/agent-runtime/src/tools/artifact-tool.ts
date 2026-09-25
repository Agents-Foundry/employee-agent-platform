import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeTool, ToolExecutionContext, ToolOutput } from './runtime-tool.js';

const MAX_ARTIFACT_BYTES = 200 * 1024;
const textTypes = [
  'report',
  'analysis_report',
  'test_report',
  'defect_draft',
  'document',
  'log',
] as const;

const inputSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
    type: z.enum(textTypes),
    mediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
    content: z.string().min(1),
  })
  .strict()
  .refine((value) => Buffer.byteLength(value.content, 'utf8') <= MAX_ARTIFACT_BYTES, {
    message: `content must be at most ${MAX_ARTIFACT_BYTES} bytes`,
  });
type ArtifactInput = z.infer<typeof inputSchema>;

/**
 * Catalog tool `artifact@1.0.0`: stores a text artifact the agent wrote and registers it on the
 * run. It has no governed actions (local write only) and cannot read or execute anything.
 */
export class ArtifactTool implements RuntimeTool<ArtifactInput> {
  readonly id = 'artifact';
  readonly version = '1.0.0';
  readonly description =
    'Save a text document you produced (report, analysis, test report, defect draft, log) as ' +
    'run evidence. The content is stored and linked to the current run.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'type', 'mediaType', 'content'],
    properties: {
      name: { type: 'string', description: 'File name, for example "test-plan.md".' },
      type: { type: 'string', enum: [...textTypes] },
      mediaType: { type: 'string', enum: ['text/markdown', 'text/plain', 'application/json'] },
      content: { type: 'string', description: 'The full document text.' },
    },
  };

  parse(input: unknown): ArtifactInput {
    return inputSchema.parse(input);
  }

  governedAction(): null {
    return null;
  }

  summarize(input: ArtifactInput): string {
    return `Store ${input.type} artifact ${input.name}`;
  }

  async execute(input: ArtifactInput, context: ToolExecutionContext): Promise<ToolOutput> {
    const id = randomUUID();
    const content = Buffer.from(input.content, 'utf8');
    const stored = await context.artifacts.put({
      organizationId: context.correlation.organizationId,
      runId: context.correlation.runId,
      artifactId: id,
      name: input.name,
      content,
    });
    await context.registerArtifact({
      id,
      type: input.type,
      mediaType: input.mediaType,
      name: input.name,
      storageReference: stored.storageReference,
      checksum: { algorithm: 'sha256', value: stored.checksum },
      sizeBytes: stored.sizeBytes,
      retentionPolicy: 'STANDARD_30D',
    });
    return {
      output: `Stored ${input.type} "${input.name}" (${stored.sizeBytes} bytes) as artifact ${id}.`,
      artifactIds: [id],
    };
  }
}
