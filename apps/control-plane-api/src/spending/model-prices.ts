import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, ModelPrice, ModelPriceBook } from '@agents-foundry/contracts';
import type { PgStore, Row } from '../db/pg-store.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';

export const DEFAULT_CURRENCY = 'USD';
const MILLION = 1_000_000n;
const MAX_PRICE = 10_000_000_000;

const price = z.number().int().min(0).max(MAX_PRICE);
const provider = z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/);
const model = z.string().regex(/^[a-zA-Z0-9._:/-]{1,160}$/);
const priceInput = z
  .object({
    provider,
    model,
    inputMicrosPerMillionTokens: price,
    outputMicrosPerMillionTokens: price,
    expectedPriceId: z.string().uuid().nullable(),
  })
  .strict();
const removalInput = z.object({ provider, model, expectedPriceId: z.string().uuid() }).strict();

/** The price a call is charged at: per million tokens, in micros. */
export interface Price {
  id: string;
  currency: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

/** What a call costs in micros, rounded up. BigInt keeps large token counts and prices exact. */
export function costMicros(price: Price, inputTokens: number, outputTokens: number): number {
  const scaled =
    BigInt(inputTokens) * BigInt(price.inputMicrosPerMillion) +
    BigInt(outputTokens) * BigInt(price.outputMicrosPerMillion);
  return Number((scaled + MILLION - 1n) / MILLION);
}

/**
 * The most output tokens a call with `inputTokens` can use without costing more than
 * `remainingMicros`: -1 if the input alone does not fit, Infinity if output is free.
 */
export function maxOutputWithin(
  price: Price,
  remainingMicros: number,
  inputTokens: number,
): number {
  const budget =
    BigInt(Math.max(0, remainingMicros)) * MILLION -
    BigInt(inputTokens) * BigInt(price.inputMicrosPerMillion);
  if (remainingMicros < 0 || budget < 0n) return -1;
  if (price.outputMicrosPerMillion === 0) return Number.POSITIVE_INFINITY;
  return Number(budget / BigInt(price.outputMicrosPerMillion));
}

/** Serializes spending decisions and price-book changes for one organization. */
export function lockSpending(db: PgStore, organizationId: string) {
  return db.get('SELECT pg_advisory_xact_lock(hashtext(?::text))', `model-spend:${organizationId}`);
}

/** Records an administrative change with its before and after state. */
export function recordChange(
  db: PgStore,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId: string,
  before: unknown,
  after: unknown,
  now: string,
) {
  return db.run(
    `INSERT INTO organization_change_events (id,organization_id,actor_id,action,resource_type,resource_id,before_json,after_json,request_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    actor.organizationId,
    actor.id,
    action,
    resourceType,
    resourceId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    randomUUID(),
    now,
  );
}

/**
 * An organization's model price book (ADR 0022). Append-only: every change adds a row that
 * supersedes the model's previous one, so the price each call was reserved under stays on
 * record. All prices are in the organization's currency.
 */
export class ModelPriceService {
  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
  ) {}

  /** The model's current price, or null when it has none. Must run in the tenant's scope. */
  async current(organizationId: string, provider: string, model: string): Promise<Price | null> {
    const row = await this.latest(organizationId, provider, model);
    if (!row || row['input_micros_per_million'] == null) return null;
    return {
      id: String(row['id']),
      currency: String(row['currency']),
      inputMicrosPerMillion: Number(row['input_micros_per_million']),
      outputMicrosPerMillion: Number(row['output_micros_per_million']),
    };
  }

  /** The organization's currency: its budget's, or the default before it has one. */
  async currency(organizationId: string): Promise<string> {
    const row = await this.db.get(
      'SELECT currency FROM organization_model_budgets WHERE organization_id=?',
      organizationId,
    );
    return row ? String(row['currency']) : DEFAULT_CURRENCY;
  }

  /** Whether the organization has ever set a price; its currency is fixed from then on. */
  async hasPriceHistory(organizationId: string): Promise<boolean> {
    return Boolean(
      await this.db.get(
        'SELECT 1 FROM model_prices WHERE organization_id=? LIMIT 1',
        organizationId,
      ),
    );
  }

  list(actor: Actor): Promise<ModelPriceBook> {
    return this.asAdmin(actor, async () => {
      const rows = await this.db.all(
        `SELECT DISTINCT ON (provider, model) * FROM model_prices WHERE organization_id=?
         ORDER BY provider, model, seq DESC`,
        actor.organizationId,
      );
      return {
        currency: await this.currency(actor.organizationId),
        prices: rows
          .filter((row) => row['input_micros_per_million'] != null)
          .map((row) => this.mapPrice(row)),
      };
    });
  }

  /** Set a model's price, superseding its current one. */
  set(actor: Actor, raw: unknown): Promise<ModelPrice> {
    const input = priceInput.parse(raw);
    return this.asAdmin(actor, async () => {
      const { before, now } = await this.begin(
        actor,
        input.provider,
        input.model,
        input.expectedPriceId,
      );
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO model_prices (id,organization_id,provider,model,currency,input_micros_per_million,
         output_micros_per_million,supersedes,set_by,set_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id,
        actor.organizationId,
        input.provider,
        input.model,
        await this.currency(actor.organizationId),
        input.inputMicrosPerMillionTokens,
        input.outputMicrosPerMillionTokens,
        before ? String(before['id']) : null,
        actor.id,
        now,
      );
      const after = this.mapPrice(
        (await this.latest(actor.organizationId, input.provider, input.model))!,
      );
      await recordChange(
        this.db,
        actor,
        'model_price.updated',
        'model_price',
        `${input.provider}/${input.model}`,
        before?.['input_micros_per_million'] == null ? null : this.mapPrice(before),
        after,
        now,
      );
      return after;
    });
  }

  /** Remove a model's price. With a cost limit set, the model can then not be called. */
  remove(actor: Actor, raw: unknown): Promise<void> {
    const input = removalInput.parse(raw);
    return this.asAdmin(actor, async () => {
      const { before, now } = await this.begin(
        actor,
        input.provider,
        input.model,
        input.expectedPriceId,
      );
      await this.db.run(
        `INSERT INTO model_prices (id,organization_id,provider,model,currency,supersedes,set_by,set_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        randomUUID(),
        actor.organizationId,
        input.provider,
        input.model,
        await this.currency(actor.organizationId),
        String(before!['id']),
        actor.id,
        now,
      );
      await recordChange(
        this.db,
        actor,
        'model_price.removed',
        'model_price',
        `${input.provider}/${input.model}`,
        this.mapPrice(before!),
        null,
        now,
      );
    });
  }

  /** Locks the organization's spending and checks the caller changes the current price. */
  private async begin(actor: Actor, provider: string, model: string, expected: string | null) {
    await lockSpending(this.db, actor.organizationId);
    const before = await this.latest(actor.organizationId, provider, model);
    const current = before?.['input_micros_per_million'] == null ? null : String(before['id']);
    if (current !== expected) throw new OrganizationDomainError(409, 'VERSION_CONFLICT');
    return { before, now: new Date().toISOString() };
  }

  private latest(organizationId: string, provider: string, model: string) {
    return this.db.get(
      `SELECT * FROM model_prices WHERE organization_id=? AND provider=? AND model=?
       ORDER BY seq DESC LIMIT 1`,
      organizationId,
      provider,
      model,
    );
  }

  private mapPrice(row: Row): ModelPrice {
    return {
      priceId: String(row['id']),
      provider: String(row['provider']),
      model: String(row['model']),
      currency: String(row['currency']),
      inputMicrosPerMillionTokens: Number(row['input_micros_per_million']),
      outputMicrosPerMillionTokens: Number(row['output_micros_per_million']),
      setBy: String(row['set_by']),
      setAt: String(row['set_at']),
    };
  }

  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return work();
    });
  }
}
