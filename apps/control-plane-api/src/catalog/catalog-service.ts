import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  AgentBlueprint,
  CatalogBlueprintSummary,
  CatalogDefinitions,
  CatalogQuestion,
  OrganizationAgentInstallation,
  QuestionScope,
  ResolvedBlueprintBundle,
} from '@agents-foundry/contracts';
import { evaluatePolicy, isKnownAction } from '../../../../packages/policy-engine/src/index.js';
import { OrganizationDomainError } from '../organization/structure-service.js';
import { resolveCatalog, type BlueprintBundleContent } from './catalog-registry.js';

export type Answers = Record<string, string | string[]>;

/** Numeric semver ordering; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = '', pre] = value.split('-', 2);
    return { parts: core.split('.').map(Number), pre };
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function answerSchema(questions: CatalogQuestion[]) {
  const fields: Record<string, z.ZodType> = {};
  for (const question of questions) {
    let field: z.ZodType;
    if (question.type === 'multiselect') {
      const options = question.options ?? [];
      field = z
        .array(z.enum(options as [string, ...string[]]))
        .min(1)
        .max(options.length)
        .refine((items) => new Set(items).size === items.length);
    } else if (question.type === 'url') {
      field = z
        .url()
        .max(2048)
        .refine((value) => {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        }, 'Use an HTTP(S) URL without embedded credentials.');
    } else {
      field = z.string().trim().min(1).max(200);
    }
    fields[question.id] = question.required ? field : field.optional();
  }
  return z.object(fields).strict();
}

/**
 * The catalog of record. Shipped definitions are validated and registered at startup; the
 * database copy is immutable and is what installations, agents and manifests resolve against,
 * so a version stays resolvable even after it stops shipping.
 */
export class CatalogService {
  constructor(
    private readonly db: DatabaseSync,
    definitions: CatalogDefinitions,
  ) {
    const bundles = resolveCatalog(definitions, isKnownAction);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { content, digest } of bundles) {
        const { blueprint } = content;
        const existing = this.db
          .prepare(
            'SELECT digest FROM catalog_blueprint_versions WHERE blueprint_id=? AND version=?',
          )
          .get(blueprint.id, blueprint.version) as { digest: string } | undefined;
        if (existing && existing.digest !== digest)
          throw new Error(`CATALOG_VERSION_MUTATED: ${blueprint.id}@${blueprint.version}`);
        if (!existing)
          this.db
            .prepare('INSERT INTO catalog_blueprint_versions VALUES (?,?,?,?,?)')
            .run(blueprint.id, blueprint.version, digest, JSON.stringify(content), now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  summaries(): CatalogBlueprintSummary[] {
    const rows = this.db
      .prepare('SELECT blueprint_id, version, digest, content FROM catalog_blueprint_versions')
      .all() as { blueprint_id: string; version: string; digest: string; content: string }[];
    const latest = new Map<string, string>();
    for (const row of rows) {
      const current = latest.get(row.blueprint_id);
      if (!current || compareVersions(row.version, current) > 0)
        latest.set(row.blueprint_id, row.version);
    }
    return rows
      .map((row) => {
        const { blueprint } = JSON.parse(row.content) as BlueprintBundleContent;
        return {
          id: blueprint.id,
          version: blueprint.version,
          title: blueprint.title,
          department: blueprint.department,
          role: blueprint.role,
          mission: blueprint.mission,
          digest: row.digest,
          latest: latest.get(row.blueprint_id) === row.version,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title) || compareVersions(b.version, a.version));
  }

  /** Resolve a registered version; unknown versions fail with `missingStatus` (400 or 404). */
  bundle(id: string, version: string, missingStatus = 400): ResolvedBlueprintBundle {
    const row = this.db
      .prepare(
        'SELECT digest, content FROM catalog_blueprint_versions WHERE blueprint_id=? AND version=?',
      )
      .get(id, version) as { digest: string; content: string } | undefined;
    if (!row) throw new OrganizationDomainError(missingStatus, 'BLUEPRINT_VERSION_UNKNOWN');
    const content = JSON.parse(row.content) as BlueprintBundleContent;
    return {
      ...content,
      // Outcomes always come from the current policy engine, never from catalog data.
      capabilities: content.blueprint.policy.actions.map((action) => ({
        action,
        outcome: evaluatePolicy(action).outcome,
      })),
      digest: row.digest,
    };
  }

  /** Legacy `/api/blueprints` shape: the latest version of each blueprint, answers unscoped. */
  legacyBlueprints(): AgentBlueprint[] {
    return this.summaries()
      .filter((summary) => summary.latest)
      .map((summary) => {
        const { blueprint, capabilities } = this.bundle(summary.id, summary.version);
        return {
          id: blueprint.id,
          version: blueprint.version,
          title: blueprint.title,
          department: blueprint.department,
          mission: blueprint.mission,
          skills: blueprint.skills.map((skill) => skill.id),
          questionnaire: blueprint.questionnaire.map(({ scope: _scope, ...question }) => question),
          capabilities,
        };
      });
  }

  validateAnswers(
    bundle: ResolvedBlueprintBundle,
    answers: unknown,
    scope: QuestionScope | 'ALL',
  ): Answers {
    const questions = bundle.blueprint.questionnaire.filter(
      (question) => scope === 'ALL' || question.scope === scope,
    );
    return answerSchema(questions).parse(answers) as Answers;
  }

  /**
   * Final answers for a new agent. With an installation, agents answer only AGENT-scoped
   * questions and inherit the installation's validated INSTALLATION-scoped configuration.
   */
  resolveAnswers(
    bundle: ResolvedBlueprintBundle,
    installation: OrganizationAgentInstallation | null,
    answers: unknown,
  ): Answers {
    if (!installation) return this.validateAnswers(bundle, answers, 'ALL');
    return {
      ...this.validateAnswers(bundle, installation.configuration, 'INSTALLATION'),
      ...this.validateAnswers(bundle, answers, 'AGENT'),
    };
  }
}

/** Generic agent label: the blueprint title plus its first agent-scoped text answer. */
export function agentLabel(bundle: ResolvedBlueprintBundle, answers: Answers): string {
  const question = bundle.blueprint.questionnaire.find(
    (item) =>
      item.scope === 'AGENT' && item.type === 'text' && typeof answers[item.id] === 'string',
  );
  const label = question
    ? `${bundle.blueprint.title} · ${answers[question.id]}`
    : bundle.blueprint.title;
  return label.slice(0, 120);
}
