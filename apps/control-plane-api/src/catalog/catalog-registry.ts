import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type {
  AgentBlueprintVersionDefinition,
  CatalogDefinitions,
  EvaluationSuiteDefinition,
  SkillDefinition,
  ToolDefinition,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import {
  blueprintVersionSchema,
  evaluationSuiteSchema,
  skillDefinitionSchema,
  toolDefinitionSchema,
  workflowDefinitionSchema,
} from '../../../../packages/contracts/src/catalog-schemas.js';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';

/** Declarative content of one blueprint version; policy outcomes are resolved separately. */
export interface BlueprintBundleContent {
  blueprint: AgentBlueprintVersionDefinition;
  skills: SkillDefinition[];
  tools: ToolDefinition[];
  workflows: WorkflowDefinition[];
}

export class CatalogError extends Error {
  constructor(readonly problems: string[]) {
    super(`CATALOG_INVALID: ${problems.join('; ')}`);
  }
}

export function bundleDigest(content: BlueprintBundleContent): string {
  return createHash('sha256').update(canonicalManifest(content)).digest('hex');
}

const key = (id: string, version: string) => `${id}@${version}`;

/**
 * Validate catalog definitions and resolve every blueprint version into a self-contained
 * bundle. Any inconsistency fails the whole catalog: a partially valid role never loads.
 */
export function resolveCatalog(
  definitions: CatalogDefinitions,
  isKnownAction: (action: string) => boolean,
): { content: BlueprintBundleContent; digest: string }[] {
  const problems: string[] = [];
  const index = <T extends { id: string; version: string }>(
    kind: string,
    items: unknown[],
    schema: z.ZodType<T>,
  ): Map<string, T> => {
    const map = new Map<string, T>();
    items.forEach((item, position) => {
      const parsed = schema.safeParse(item);
      if (!parsed.success) {
        problems.push(
          `${kind}[${position}]: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`,
        );
        return;
      }
      const id = key(parsed.data.id, parsed.data.version);
      if (map.has(id)) problems.push(`${kind} ${id}: duplicate version`);
      map.set(id, parsed.data);
    });
    return map;
  };
  const skills = index('skill', definitions.skills, skillDefinitionSchema);
  const tools = index('tool', definitions.tools, toolDefinitionSchema);
  const workflows = index('workflow', definitions.workflows, workflowDefinitionSchema);
  const blueprints = index('blueprint', definitions.blueprints, blueprintVersionSchema);

  const bundles: { content: BlueprintBundleContent; digest: string }[] = [];
  for (const blueprint of blueprints.values()) {
    const at = `blueprint ${key(blueprint.id, blueprint.version)}`;
    const resolve = <T>(
      kind: string,
      refs: { id: string; version: string }[],
      map: Map<string, T>,
    ) => {
      if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
        problems.push(`${at}: ${kind} ids must be unique`);
      return refs.flatMap((ref) => {
        const found = map.get(key(ref.id, ref.version));
        if (!found) problems.push(`${at}: unknown ${kind} ${key(ref.id, ref.version)}`);
        return found ? [found] : [];
      });
    };
    const content: BlueprintBundleContent = {
      blueprint,
      skills: resolve('skill', blueprint.skills, skills),
      tools: resolve('tool', blueprint.tools, tools),
      workflows: resolve('workflow', blueprint.workflows, workflows),
    };
    const toolIds = new Set(blueprint.tools.map((tool) => tool.id));
    const skillIds = new Set(blueprint.skills.map((skill) => skill.id));
    const connectorCapabilities = new Set(blueprint.connectors.flatMap((c) => c.capabilities));
    const actions = new Set(blueprint.policy.actions);
    const questions = new Map(blueprint.questionnaire.map((q) => [q.id, q]));
    for (const action of actions)
      if (!isKnownAction(action)) problems.push(`${at}: policy action ${action} is unknown`);
    for (const skill of content.skills) {
      for (const tool of skill.requires.tools)
        if (!toolIds.has(tool)) problems.push(`${at}: skill ${skill.id} requires tool ${tool}`);
      for (const capability of skill.requires.connectorCapabilities)
        if (!connectorCapabilities.has(capability))
          problems.push(`${at}: skill ${skill.id} requires connector capability ${capability}`);
    }
    for (const workflow of content.workflows)
      for (const step of workflow.steps) {
        if (!skillIds.has(step.skill))
          problems.push(`${at}: workflow ${workflow.id} step ${step.id} uses skill ${step.skill}`);
        if (step.action && !actions.has(step.action))
          problems.push(`${at}: workflow ${workflow.id} step ${step.id} action ${step.action}`);
      }
    for (const connector of blueprint.connectors) {
      const question = questions.get(connector.selection.questionId);
      const options = [...(question?.options ?? [])].sort();
      if (question?.type !== 'multiselect')
        problems.push(`${at}: connector ${connector.capability} needs a multiselect question`);
      else if (
        canonicalManifest(options) !==
        canonicalManifest(Object.keys(connector.selection.providers).sort())
      )
        problems.push(`${at}: connector ${connector.capability} must map every option`);
    }
    for (const mcp of blueprint.mcp) {
      if (!mcp.whenAnswer) continue;
      const question = questions.get(mcp.whenAnswer.questionId);
      if (question?.type !== 'multiselect' || !question.options?.includes(mcp.whenAnswer.includes))
        problems.push(`${at}: mcp ${mcp.id} condition references an unknown option`);
    }
    bundles.push({ content, digest: bundleDigest(content) });
  }
  validateEvaluations(definitions, [...blueprints.values()], tools, isKnownAction, problems);
  if (problems.length) throw new CatalogError(problems);
  return bundles;
}

/**
 * Every role version names an evaluation suite (ADR 0019). Suites must exist, belong to that
 * role, and only use workflows, answers, tools and actions that are real. They are not part
 * of any bundle, so adding or improving evaluations never changes a released version.
 */
function validateEvaluations(
  definitions: CatalogDefinitions,
  blueprints: AgentBlueprintVersionDefinition[],
  tools: Map<string, ToolDefinition>,
  isKnownAction: (action: string) => boolean,
  problems: string[],
): void {
  const suites = new Map<string, EvaluationSuiteDefinition>();
  (definitions.evaluationSuites ?? []).forEach((item, position) => {
    const parsed = evaluationSuiteSchema.safeParse(item);
    if (!parsed.success) {
      problems.push(
        `evaluationSuite[${position}]: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`,
      );
      return;
    }
    if (suites.has(parsed.data.id)) problems.push(`evaluation suite ${parsed.data.id}: duplicate`);
    suites.set(parsed.data.id, parsed.data);
  });
  const toolIds = new Set([...tools.values()].map((tool) => tool.id));
  for (const blueprint of blueprints) {
    const suite = suites.get(blueprint.evaluations.suite);
    const at = `blueprint ${key(blueprint.id, blueprint.version)}`;
    if (!suite) problems.push(`${at}: unknown evaluation suite ${blueprint.evaluations.suite}`);
    else if (suite.blueprintId !== blueprint.id)
      problems.push(`${at}: evaluation suite ${suite.id} belongs to ${suite.blueprintId}`);
  }
  for (const suite of suites.values()) {
    const versions = blueprints.filter(
      (blueprint) => blueprint.id === suite.blueprintId && blueprint.evaluations.suite === suite.id,
    );
    if (!versions.length) problems.push(`evaluation suite ${suite.id}: no blueprint uses it`);
    const issues = new Set(suite.world.issues.map((issue) => issue.key));
    for (const scenario of suite.scenarios) {
      const at = `evaluation ${suite.id}/${scenario.id}`;
      const applicable = scenario.blueprintVersions
        ? scenario.blueprintVersions.map((version) => {
            const found = versions.find((blueprint) => blueprint.version === version);
            if (!found) problems.push(`${at}: version ${version} does not use this suite`);
            return found;
          })
        : versions;
      for (const blueprint of applicable) {
        if (!blueprint) continue;
        const version = `${at} on ${blueprint.version}`;
        if (!blueprint.workflows.some((workflow) => workflow.id === scenario.task.workflow))
          problems.push(`${version}: workflow ${scenario.task.workflow} is not in the blueprint`);
        const questions = new Map(blueprint.questionnaire.map((q) => [q.id, q]));
        for (const answer of Object.keys(scenario.answers))
          if (!questions.has(answer)) problems.push(`${version}: unknown answer ${answer}`);
        for (const question of questions.values())
          if (question.required && !(question.id in scenario.answers))
            problems.push(`${version}: missing required answer ${question.id}`);
      }
      if (scenario.task.workItemKey && !issues.has(scenario.task.workItemKey))
        problems.push(`${at}: work item ${scenario.task.workItemKey} is not in the world`);
      for (const step of scenario.steps) {
        if (!toolIds.has(step.tool)) problems.push(`${at}: unknown tool ${step.tool}`);
        if (step.expect.approval && !isKnownAction(step.expect.approval.action))
          problems.push(`${at}: unknown approval action ${step.expect.approval.action}`);
      }
      for (const action of scenario.expect.executedActions)
        if (!isKnownAction(action)) problems.push(`${at}: unknown executed action ${action}`);
    }
  }
}
