// Strict schemas for catalog definitions (Node consumers: control plane, role-package CI).
import { z } from 'zod';
import type {
  AgentBlueprintVersionDefinition,
  SkillDefinition,
  ToolDefinition,
  WorkflowDefinition,
} from './catalog.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const action = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const capability = z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9_]*)+$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const reference = z.object({ id: slug, version: semver }).strict();
const unique = <T>(items: T[]) => new Set(items).size === items.length;

export const skillDefinitionSchema = z
  .object({
    id: slug,
    version: semver,
    title: text(120),
    description: text(1000),
    requires: z
      .object({
        tools: z.array(slug).max(20).refine(unique),
        connectorCapabilities: z.array(capability).max(20).refine(unique),
      })
      .strict(),
    activatesWhen: z.object({ workflows: z.array(slug).max(50).refine(unique) }).strict(),
  })
  .strict() satisfies z.ZodType<SkillDefinition>;

export const toolDefinitionSchema = z
  .object({
    id: slug,
    version: semver,
    description: text(1000),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    executionLocation: z.enum(['LOCAL', 'EXECUTION_RUNTIME', 'CONTROL_PLANE']),
    sideEffects: z.enum(['NONE', 'LOCAL_WRITE', 'EXTERNAL_WRITE']),
    governedActions: z.array(action).max(50).refine(unique),
    timeoutMs: z.number().int().min(1000).max(3_600_000),
  })
  .strict() satisfies z.ZodType<ToolDefinition>;

export const workflowDefinitionSchema = z
  .object({
    id: slug,
    version: semver,
    title: text(120),
    description: text(1000),
    steps: z
      .array(
        z.object({ id: slug, title: text(120), skill: slug, action: action.optional() }).strict(),
      )
      .min(1)
      .max(50)
      .refine((steps) => unique(steps.map((step) => step.id)), 'Step ids must be unique.'),
  })
  .strict() satisfies z.ZodType<WorkflowDefinition>;

const question = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,59}$/),
    label: text(120),
    type: z.enum(['text', 'url', 'multiselect']),
    required: z.boolean(),
    options: z.array(text(80)).min(1).max(50).refine(unique).optional(),
    scope: z.enum(['INSTALLATION', 'AGENT']),
  })
  .strict()
  .refine(
    (q) => (q.type === 'multiselect') === Boolean(q.options),
    'Only multiselect has options.',
  );

export const blueprintVersionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
    version: semver,
    title: text(120),
    department: text(120),
    role: slug,
    mission: text(1000),
    persona: z.object({ profile: slug }).strict(),
    runtime: z.object({ profile: slug, isolation: z.enum(['sandboxed', 'local']) }).strict(),
    model: z.object({ profile: slug }).strict(),
    skills: z.array(reference).max(100),
    tools: z.array(reference).max(100),
    workflows: z.array(reference).max(100),
    connectors: z
      .array(
        z
          .object({
            capability: z.string().regex(/^[a-z][A-Za-z0-9]{0,59}$/),
            capabilities: z.array(capability).min(1).max(20).refine(unique),
            selection: z
              .object({
                questionId: z.string().min(1).max(60),
                providers: z.record(text(80), slug),
              })
              .strict(),
          })
          .strict(),
      )
      .max(20),
    mcp: z
      .array(
        z
          .object({
            id: slug,
            whenAnswer: z
              .object({ questionId: z.string().min(1).max(60), includes: text(80) })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(20),
    memory: z.object({ profile: slug }).strict(),
    knowledge: z.object({ sources: z.array(slug).max(50).refine(unique) }).strict(),
    policy: z
      .object({ profile: slug, actions: z.array(action).min(1).max(100).refine(unique) })
      .strict(),
    evaluations: z.object({ suite: slug }).strict(),
    questionnaire: z
      .array(question)
      .max(50)
      .refine((items) => unique(items.map((item) => item.id)), 'Question ids must be unique.'),
  })
  .strict() satisfies z.ZodType<AgentBlueprintVersionDefinition>;
