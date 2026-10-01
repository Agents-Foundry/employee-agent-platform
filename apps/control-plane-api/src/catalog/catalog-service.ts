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
import {
  CATALOG_BUNDLE_SCHEMA,
  resolveCatalog,
  storedBundleProblems,
  type BlueprintBundleContent,
} from './catalog-registry.js';
import { ChangeListener, type ChangeFeed } from '../db/change-listener.js';
import type { PgStore } from '../db/pg-store.js';

export type Answers = Record<string, string | string[]>;

type CatalogRow = {
  blueprint_id: string;
  version: string;
  digest: string;
  bundle_schema: string;
  content: string;
};

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

/** The channel migration 0009 notifies when a blueprint version is registered. */
export const CATALOG_VERSION_CHANNEL = 'af_catalog_versions';

const key = (id: string, version: string) => `${id}@${version}`;

/** Whether this release can serve a stored version (ADR 0030). */
function verified(row: CatalogRow): boolean {
  return (
    storedBundleProblems(
      {
        blueprintId: row.blueprint_id,
        version: row.version,
        digest: row.digest,
        schema: row.bundle_schema,
        content: row.content,
      },
      isKnownAction,
    ).length === 0
  );
}

/**
 * The catalog of record. Shipped definitions are validated and registered at startup; the
 * database copy is immutable and is what installations, agents and manifests resolve against,
 * so a version stays resolvable even after it stops shipping.
 *
 * Registered versions are immutable, so each instance serves them from memory. A version
 * registered by another instance is loaded when its notification arrives (ADR 0029). Until
 * then, resolving it reads it from the database, so it never fails only because this instance
 * has not heard of it yet. Listings reload first whenever notifications are not being received.
 */
export class CatalogService {
  private readonly rows = new Map<string, CatalogRow>();
  private readonly listener: ChangeListener;
  private loading: Promise<void> | undefined;
  private dirty = false;
  private stale = false;

  private constructor(
    private readonly db: PgStore,
    rows: readonly CatalogRow[],
    feed: ChangeFeed,
    retryMs?: number,
  ) {
    this.add(rows);
    this.listener = new ChangeListener(
      feed,
      CATALOG_VERSION_CHANNEL,
      {
        onChange: () =>
          void this.reload().catch(() => {
            // Marked stale; listings reload again before they are served.
          }),
      },
      retryMs,
    );
  }

  /** Registers the shipped definitions (platform scope) and loads every registered version. */
  static async open(
    db: PgStore,
    definitions: CatalogDefinitions,
    options: { feed?: ChangeFeed; retryMs?: number } = {},
  ): Promise<CatalogService> {
    const bundles = resolveCatalog(definitions, isKnownAction);
    const now = new Date().toISOString();
    const rows = await db.platform(async () => {
      for (const { content, digest } of bundles) {
        const { blueprint } = content;
        const existing = await db.get<{ digest: string }>(
          'SELECT digest FROM catalog_blueprint_versions WHERE blueprint_id=? AND version=?',
          blueprint.id,
          blueprint.version,
        );
        if (existing && existing.digest !== digest)
          throw new Error(`CATALOG_VERSION_MUTATED: ${blueprint.id}@${blueprint.version}`);
        if (!existing)
          await db.run(
            'INSERT INTO catalog_blueprint_versions (blueprint_id,version,digest,bundle_schema,content,registered_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
            blueprint.id,
            blueprint.version,
            digest,
            CATALOG_BUNDLE_SCHEMA,
            JSON.stringify(content),
            now,
          );
      }
      return db.all<CatalogRow>(
        'SELECT blueprint_id, version, digest, bundle_schema, content FROM catalog_blueprint_versions',
      );
    });
    const catalog = new CatalogService(db, rows, options.feed ?? db, options.retryMs);
    // A concurrent start of a different release may have registered first.
    for (const { content, digest } of bundles) {
      const { id, version } = content.blueprint;
      if (catalog.rows.get(key(id, version))?.digest !== digest)
        throw new Error(`CATALOG_VERSION_MUTATED: ${id}@${version}`);
    }
    return catalog;
  }

  /** Whether versions registered elsewhere are loaded as they are notified. */
  get live(): boolean {
    return this.listener.live;
  }

  /** Starts listening for versions registered elsewhere. Never throws; failures retry. */
  start(): Promise<void> {
    return this.listener.start();
  }

  stop(): void {
    this.listener.stop();
  }

  /** Loads every version registered since the last load; concurrent calls share one load. */
  reload(): Promise<void> {
    this.dirty = true;
    this.loading ??= (async () => {
      try {
        // A notification during a load may not be reflected in it, so load once more.
        while (this.dirty) {
          this.dirty = false;
          this.add(
            await this.read(() =>
              this.db.all<CatalogRow>(
                'SELECT blueprint_id, version, digest, bundle_schema, content FROM catalog_blueprint_versions',
              ),
            ),
          );
        }
        this.stale = false;
      } catch (error) {
        this.stale = true;
        throw error;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  async summaries(): Promise<CatalogBlueprintSummary[]> {
    if (this.loading) await this.loading.catch(() => {});
    if (!this.live || this.stale) await this.reload();
    const rows = [...this.rows.values()];
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

  /**
   * Resolve a registered version, reading it from the database if this instance has not loaded
   * it yet. Unknown versions fail with `missingStatus` (400 or 404); a version this release
   * cannot verify fails with 409.
   */
  async bundle(id: string, version: string, missingStatus = 400): Promise<ResolvedBlueprintBundle> {
    const row = this.rows.get(key(id, version)) ?? (await this.fetch(id, version));
    if (!row) throw new OrganizationDomainError(missingStatus, 'BLUEPRINT_VERSION_UNKNOWN');
    return this.resolved(row);
  }

  /** Legacy `/api/blueprints` shape: the latest version of each blueprint, answers unscoped. */
  async legacyBlueprints(): Promise<AgentBlueprint[]> {
    return (await this.summaries())
      .filter((summary) => summary.latest)
      .map((summary) => {
        const { blueprint, capabilities } = this.resolved(
          this.rows.get(key(summary.id, summary.version))!,
        );
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

  private resolved(row: CatalogRow): ResolvedBlueprintBundle {
    // Parsed on every use, so no caller can change the stored content.
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

  private async fetch(id: string, version: string): Promise<CatalogRow | undefined> {
    const row = await this.read(() =>
      this.db.get<CatalogRow>(
        'SELECT blueprint_id, version, digest, bundle_schema, content FROM catalog_blueprint_versions WHERE blueprint_id=? AND version=?',
        id,
        version,
      ),
    );
    if (!row) return undefined;
    if (!verified(row)) throw new OrganizationDomainError(409, 'BLUEPRINT_VERSION_UNSUPPORTED');
    this.rows.set(key(id, version), row);
    return row;
  }

  /** Versions are global; the tenant role may read them inside its own transaction. */
  private read<T>(work: () => Promise<T>): Promise<T> {
    return this.db.scope() ? work() : this.db.platform(work);
  }

  /** Versions are immutable, so loaded ones are kept; unverifiable ones are never served. */
  private add(rows: readonly CatalogRow[]): void {
    for (const row of rows) {
      const id = key(row.blueprint_id, row.version);
      if (!this.rows.has(id) && verified(row)) this.rows.set(id, row);
    }
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
