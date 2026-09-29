// Strict schemas for catalog definitions (Node consumers: control plane, role-package CI).
import { z } from 'zod';
import type {
  AgentBlueprintVersionDefinition,
  EvaluationSuiteDefinition,
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

const issueKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,8}$/);
const relativePath = z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/);
const answers = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const evaluationTask = z
  .object({
    objective: text(500),
    workflow: slug,
    workItemKey: issueKey.optional(),
    inputs: z.record(z.string(), z.string().max(2000)).optional(),
  })
  .strict();
const blueprintVersions = z.array(semver).min(1).max(20).refine(unique).optional();
const weight = z.number().positive().max(100);
const needles = z.array(text(200)).min(1).max(20).optional();
const check = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ id: slug, weight, required: z.boolean().optional(), ...shape }).strict();

const qualityTaskSchema = z
  .object({
    id: slug,
    title: text(200),
    blueprintVersions,
    answers,
    task: evaluationTask,
    approve: z.array(action).max(20).refine(unique),
    executionResults: z
      .array(
        z
          .object({
            operation: z.enum(['command', 'dependencies.install', 'playwright.run']),
            match: text(300),
            status: z.enum(['SUCCEEDED', 'FAILED']),
            output: z.string().max(20_000),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    budget: z
      .object({
        maxTurns: z.number().int().min(1).max(50),
        maxInputTokens: z.number().int().min(1000).max(5_000_000),
        maxOutputTokens: z.number().int().min(100).max(500_000),
      })
      .strict(),
    checks: z
      .array(
        z.discriminatedUnion('kind', [
          check({ kind: z.enum(['tool-called', 'tool-not-called']), tool: slug }),
          check({ kind: z.enum(['action-executed', 'action-not-executed']), action }),
          check({ kind: z.literal('no-denials') }),
          check({
            kind: z.literal('run-status'),
            status: z.enum(['COMPLETED', 'CANCELLED', 'FAILED']),
          }),
          check({
            kind: z.literal('artifact'),
            type: z.enum(['report', 'test_report']),
            contains: needles,
          }),
          check({
            kind: z.literal('file-written'),
            pathIncludes: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/),
            contains: needles,
          }),
        ]),
      )
      .max(30),
    rubric: z.array(z.object({ id: slug, description: text(500), weight }).strict()).max(20),
    passThreshold: z.number().min(0).max(1),
  })
  .strict()
  .refine((task) => task.checks.length + task.rubric.length > 0, 'A task needs a check.')
  .refine(
    (task) => unique([...task.checks.map((c) => c.id), ...task.rubric.map((c) => c.id)]),
    'Check and criterion ids must be unique.',
  );

export const evaluationSuiteSchema = z
  .object({
    id: slug,
    blueprintId: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
    title: text(120),
    world: z
      .object({
        issueProjects: z
          .array(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/))
          .max(20)
          .refine(unique),
        issues: z
          .array(
            z
              .object({
                key: issueKey,
                type: z.enum(['Bug', 'Task', 'Story']),
                summary: text(255),
                description: text(5000),
              })
              .strict(),
          )
          .max(50),
        repositories: z
          .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/))
          .max(20)
          .refine(unique),
        repositoryFiles: z.record(relativePath, z.string().max(20_000)),
      })
      .strict(),
    scenarios: z
      .array(
        z
          .object({
            id: slug,
            title: text(200),
            blueprintVersions,
            answers,
            task: evaluationTask,
            steps: z
              .array(
                z
                  .object({
                    tool: slug,
                    input: z.record(z.string(), z.unknown()),
                    expect: z
                      .object({
                        outcome: z.enum(['SUCCEEDED', 'FAILED', 'NOT_AVAILABLE']),
                        code: z
                          .string()
                          .regex(/^[A-Z][A-Z0-9_]*$/)
                          .optional(),
                        contains: text(500).optional(),
                        approval: z
                          .object({ action, decision: z.enum(['APPROVED', 'REJECTED']) })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .refine(
                        (e) => (e.outcome === 'FAILED') === Boolean(e.code),
                        'A FAILED step names its error code, and only a FAILED step does.',
                      ),
                  })
                  .strict(),
              )
              .min(1)
              .max(30),
            expect: z
              .object({
                offeredTools: z.array(slug).max(50).refine(unique),
                runStatus: z.enum(['COMPLETED', 'CANCELLED', 'FAILED']),
                executedActions: z.array(action).max(30),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .refine((items) => unique(items.map((item) => item.id)), 'Scenario ids must be unique.'),
    qualityTasks: z
      .array(qualityTaskSchema)
      .max(50)
      .refine((items) => unique(items.map((item) => item.id)), 'Quality task ids must be unique.')
      .optional(),
  })
  .strict() satisfies z.ZodType<EvaluationSuiteDefinition>;

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
