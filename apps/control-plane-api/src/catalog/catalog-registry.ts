import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type {
  AgentBlueprintVersionDefinition,
  CatalogDefinitions,
  SkillDefinition,
  ToolDefinition,
  WorkflowDefinition,
} from '@agents-foundry/contracts';
import {
  blueprintVersionSchema,
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
  if (problems.length) throw new CatalogError(problems);
  return bundles;
}
