import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type {
  Actor,
  AlertWebhook,
  AlertWebhookDelivery,
  AlertWebhookList,
  ModelBudgetAlert,
  WebhookEvent,
  WebhookEventType,
} from '@agents-foundry/contracts';
import { WEBHOOK_HEADERS } from '../../../../packages/contracts/src/webhooks.js';
import type { Audit } from '../actions/action-policy-service.js';
import type { PgStore, Row } from '../db/pg-store.js';
import type { ManifestSigner } from '../manifest-signing.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import { recordChange } from '../spending/model-prices.js';
import { webhookErrorCode, webhookTransport, type WebhookSend } from './webhook-transport.js';

/** Endpoints an organization may register, active or not. */
export const MAX_WEBHOOKS = 10;
export const MAX_ATTEMPTS = 6;
/** Wait before each retry: 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
const TIMEOUT_MS = 10_000;
/** A claimed delivery is not claimed again for this long, so a crash only delays it. */
const LEASE_MS = 120_000;
const RECENT_DELIVERIES = 25;
const SYSTEM_ACTOR = 'control-plane';
const privateSuffixes = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.intranet',
  '.corp',
  '.home.arpa',
];

const createInput = z
  .object({ url: z.string().max(500), description: z.string().trim().max(200) })
  .strict();
const statusInput = z
  .object({ status: z.enum(['ACTIVE', 'DISABLED']), version: z.number().int().min(1) })
  .strict();
const webhookId = z.string().uuid();

export interface AlertWebhookOptions {
  /** `ALERT_WEBHOOKS_ENABLED`: without it nothing is registered, queued or sent. */
  enabled: boolean;
  /** Allow plain HTTP and private hosts (local testing only). */
  allowPrivateNetwork: boolean;
  /** Outbound HTTP (tests); defaults to the guarded transport. */
  send?: WebhookSend;
}

/**
 * Alert webhooks (ADR 0024). Organizations register HTTPS endpoints; each budget alert is
 * queued for every active endpoint in the transaction that raises it, and a dispatcher sends
 * it, signed with the control plane's key, retrying with backoff. Delivery is at least once:
 * receivers drop duplicates by delivery id.
 */
export class AlertWebhookService {
  private readonly send: WebhookSend;
  private running = false;

  constructor(
    private readonly db: PgStore,
    private readonly structure: OrganizationStructureService,
    private readonly signer: ManifestSigner,
    private readonly audit: Audit,
    readonly options: AlertWebhookOptions,
  ) {
    this.send =
      options.send ?? webhookTransport({ allowPrivateNetwork: options.allowPrivateNetwork });
  }

  list(actor: Actor): Promise<AlertWebhookList> {
    return this.asAdmin(actor, async () => {
      const webhooks = await this.db.all(
        'SELECT * FROM organization_alert_webhooks WHERE organization_id=? ORDER BY created_at, id',
        actor.organizationId,
      );
      const deliveries = await this.db.all(
        `SELECT * FROM alert_webhook_deliveries WHERE organization_id=? ORDER BY seq DESC LIMIT ${RECENT_DELIVERIES}`,
        actor.organizationId,
      );
      return {
        webhooks: webhooks.map((row) => this.mapWebhook(row)),
        deliveries: deliveries.map((row) => this.mapDelivery(row)),
        signingKey: this.signer.verificationKey,
      };
    });
  }

  create(actor: Actor, raw: unknown): Promise<AlertWebhook> {
    const input = createInput.parse(raw);
    const url = this.normalizeUrl(input.url);
    return this.asAdmin(actor, async () => {
      const count = await this.db.get(
        'SELECT count(*) AS n FROM organization_alert_webhooks WHERE organization_id=?',
        actor.organizationId,
      );
      if (Number(count?.['n'] ?? 0) >= MAX_WEBHOOKS)
        throw new OrganizationDomainError(409, 'ALERT_WEBHOOK_LIMIT');
      const id = randomUUID();
      const now = new Date().toISOString();
      await this.db.run(
        `INSERT INTO organization_alert_webhooks (id,organization_id,url,description,status,created_by,created_at,updated_by,updated_at)
         VALUES (?,?,?,?,'ACTIVE',?,?,?,?)`,
        id,
        actor.organizationId,
        url,
        input.description,
        actor.id,
        now,
        actor.id,
        now,
      );
      const created = this.mapWebhook((await this.row(actor.organizationId, id))!);
      await recordChange(
        this.db,
        actor,
        'alert_webhook.created',
        'alert_webhook',
        id,
        null,
        created,
        now,
      );
      return created;
    });
  }

  /** Enable or disable an endpoint. Deliveries to a disabled endpoint wait until it is enabled. */
  setStatus(actor: Actor, rawId: unknown, raw: unknown): Promise<AlertWebhook> {
    const id = webhookId.parse(rawId);
    const input = statusInput.parse(raw);
    return this.asAdmin(actor, async () => {
      const before = await this.row(actor.organizationId, id);
      if (!before) throw new OrganizationDomainError(404, 'ALERT_WEBHOOK_NOT_FOUND');
      const now = new Date().toISOString();
      const { changes } = await this.db.run(
        `UPDATE organization_alert_webhooks SET status=?, version=version+1, updated_by=?, updated_at=?
         WHERE id=? AND organization_id=? AND version=?`,
        input.status,
        actor.id,
        now,
        id,
        actor.organizationId,
        input.version,
      );
      if (changes !== 1) throw new OrganizationDomainError(409, 'VERSION_CONFLICT');
      const after = this.mapWebhook((await this.row(actor.organizationId, id))!);
      await recordChange(
        this.db,
        actor,
        'alert_webhook.updated',
        'alert_webhook',
        id,
        this.mapWebhook(before),
        after,
        now,
      );
      return after;
    });
  }

  /** Queue a test delivery to an active endpoint. */
  test(actor: Actor, rawId: unknown): Promise<AlertWebhookDelivery> {
    const id = webhookId.parse(rawId);
    return this.asAdmin(actor, async () => {
      const webhook = await this.row(actor.organizationId, id);
      if (!webhook) throw new OrganizationDomainError(404, 'ALERT_WEBHOOK_NOT_FOUND');
      if (webhook['status'] !== 'ACTIVE')
        throw new OrganizationDomainError(409, 'ALERT_WEBHOOK_DISABLED');
      const deliveryId = await this.enqueue(
        actor.organizationId,
        id,
        'webhook.test',
        null,
        { message: 'Test delivery from Agents Foundry.' },
        Date.now(),
      );
      return this.mapDelivery(
        (await this.db.get(
          'SELECT * FROM alert_webhook_deliveries WHERE id=? AND organization_id=?',
          deliveryId,
          actor.organizationId,
        ))!,
      );
    });
  }

  /**
   * Queue an alert for every active endpoint, in the caller's transaction, so an alert is
   * never raised without its deliveries. Must run in the tenant's scope.
   */
  async enqueueAlert(organizationId: string, alert: ModelBudgetAlert, nowMs: number) {
    if (!this.options.enabled) return;
    const webhooks = await this.db.all(
      "SELECT id FROM organization_alert_webhooks WHERE organization_id=? AND status='ACTIVE'",
      organizationId,
    );
    for (const webhook of webhooks)
      await this.enqueue(
        organizationId,
        String(webhook['id']),
        'model.budget.alert',
        alert.id,
        { alert },
        nowMs,
      );
  }

  /**
   * Send the deliveries that are due, across organizations, and record each outcome. Returns
   * how many were attempted.
   */
  async dispatchDue(nowMs = Date.now(), limit = 10): Promise<number> {
    if (!this.options.enabled) return 0;
    const now = new Date(nowMs).toISOString();
    const claimed = await this.db.platform(() =>
      this.db.all(
        `UPDATE alert_webhook_deliveries d SET attempts=d.attempts+1, last_attempt_at=?, next_attempt_at=?
         FROM organization_alert_webhooks w
         WHERE w.id=d.webhook_id AND d.id IN (
           SELECT d2.id FROM alert_webhook_deliveries d2
           JOIN organization_alert_webhooks w2 ON w2.id=d2.webhook_id
           WHERE d2.status='PENDING' AND d2.next_attempt_at<=? AND w2.status='ACTIVE'
           ORDER BY d2.next_attempt_at LIMIT ? FOR UPDATE OF d2 SKIP LOCKED)
         RETURNING d.id, d.organization_id, d.webhook_id, d.body, d.attempts, d.seq, w.url`,
        now,
        new Date(nowMs + LEASE_MS).toISOString(),
        now,
        limit,
      ),
    );
    // RETURNING has no order; send the oldest first.
    claimed.sort((a, b) => Number(a['seq']) - Number(b['seq']));
    for (const delivery of claimed) await this.attempt(delivery, nowMs);
    return claimed.length;
  }

  /** Dispatch every `intervalMs` until stopped; overlapping runs are skipped. */
  start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.dispatchDue()
        .catch((error: unknown) =>
          console.error(`Alert webhook dispatch failed: ${webhookErrorCode(error)}`),
        )
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async attempt(delivery: Row, nowMs: number) {
    const id = String(delivery['id']);
    const body = String(delivery['body']);
    const attempts = Number(delivery['attempts']);
    const timestamp = Math.floor(nowMs / 1000);
    let status: number | null = null;
    let error: string | null = null;
    try {
      status = (
        await this.send(
          String(delivery['url']),
          {
            'content-type': 'application/json',
            'user-agent': 'AgentsFoundry-Webhooks/1',
            [WEBHOOK_HEADERS.id]: id,
            [WEBHOOK_HEADERS.timestamp]: String(timestamp),
            [WEBHOOK_HEADERS.keyId]: this.signer.verificationKey.keyId,
            [WEBHOOK_HEADERS.signature]: `ed25519=${this.signer.signWebhook(id, timestamp, body)}`,
          },
          body,
          TIMEOUT_MS,
        )
      ).status;
    } catch (caught) {
      error = webhookErrorCode(caught);
    }
    const delivered = status !== null && status >= 200 && status < 300;
    if (status !== null && !delivered) error = `WEBHOOK_HTTP_${status}`;
    // Timeouts, connection failures, 408, 429 and server errors are retried; anything else
    // (a blocked address, a redirect, another client error) will not succeed by waiting.
    const retryable =
      !delivered &&
      (status === null
        ? error !== 'WEBHOOK_ADDRESS_BLOCKED' && error !== 'WEBHOOK_URL_INVALID'
        : status === 408 || status === 429 || status >= 500);
    const outcome = delivered
      ? 'DELIVERED'
      : retryable && attempts < MAX_ATTEMPTS
        ? 'PENDING'
        : 'FAILED';
    const organizationId = String(delivery['organization_id']);
    await this.db.platform(async () => {
      const { changes } = await this.db.run(
        `UPDATE alert_webhook_deliveries SET status=?, next_attempt_at=?, last_status_code=?, last_error=?, delivered_at=?
         WHERE id=? AND status='PENDING' AND attempts=?`,
        outcome,
        outcome === 'PENDING'
          ? new Date(nowMs + RETRY_DELAYS_MS[attempts - 1]!).toISOString()
          : null,
        status !== null && status >= 100 && status <= 599 ? status : null,
        delivered ? null : error,
        delivered ? new Date(nowMs).toISOString() : null,
        id,
        attempts,
      );
      if (changes === 1 && outcome === 'FAILED')
        await this.audit(
          SYSTEM_ACTOR,
          'alert.webhook.failed',
          'alert_webhook_delivery',
          id,
          { webhookId: String(delivery['webhook_id']), attempts, error },
          organizationId,
        );
    });
  }

  private async enqueue(
    organizationId: string,
    webhookId: string,
    type: WebhookEventType,
    alertId: string | null,
    data: object,
    nowMs: number,
  ): Promise<string> {
    const id = randomUUID();
    const createdAt = new Date(nowMs).toISOString();
    const event = { type, deliveryId: id, organizationId, createdAt, data } as WebhookEvent;
    await this.db.run(
      `INSERT INTO alert_webhook_deliveries (id,organization_id,webhook_id,event_type,alert_id,body,status,next_attempt_at,created_at)
       VALUES (?,?,?,?,?,?,'PENDING',?,?) ON CONFLICT (webhook_id,alert_id) DO NOTHING`,
      id,
      organizationId,
      webhookId,
      type,
      alertId,
      JSON.stringify(event),
      createdAt,
      createdAt,
    );
    return id;
  }

  /**
   * HTTPS on the default port to a public host name. Addresses are checked again when a
   * delivery connects, since a name can resolve differently later.
   */
  private normalizeUrl(value: string): string {
    const invalid = () => new OrganizationDomainError(400, 'ALERT_WEBHOOK_URL_INVALID');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid();
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateHost =
      isIP(host) !== 0 ||
      host === 'localhost' ||
      !host.includes('.') ||
      privateSuffixes.some((suffix) => host.endsWith(suffix));
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['https:', 'http:'].includes(url.protocol) ||
      (!this.options.allowPrivateNetwork &&
        (url.protocol !== 'https:' || url.port !== '' || privateHost))
    )
      throw invalid();
    return url.href;
  }

  /** Origin and the last four characters of the rest: paths and queries can carry tokens. */
  private displayUrl(value: string): string {
    const url = new URL(value);
    const rest = `${url.pathname}${url.search}`.replace(/^\/$/, '');
    return rest ? `${url.origin}/…${rest.slice(-4)}` : url.origin;
  }

  private row(organizationId: string, id: string) {
    return this.db.get(
      'SELECT * FROM organization_alert_webhooks WHERE id=? AND organization_id=?',
      id,
      organizationId,
    );
  }

  private mapWebhook(row: Row): AlertWebhook {
    return {
      id: String(row['id']),
      displayUrl: this.displayUrl(String(row['url'])),
      description: String(row['description']),
      status: row['status'] as AlertWebhook['status'],
      version: Number(row['version']),
      createdBy: String(row['created_by']),
      createdAt: String(row['created_at']),
      updatedBy: String(row['updated_by']),
      updatedAt: String(row['updated_at']),
    };
  }

  private mapDelivery(row: Row): AlertWebhookDelivery {
    const optional = (key: string) => (row[key] == null ? null : String(row[key]));
    return {
      id: String(row['id']),
      webhookId: String(row['webhook_id']),
      eventType: row['event_type'] as WebhookEventType,
      alertId: optional('alert_id'),
      status: row['status'] as AlertWebhookDelivery['status'],
      attempts: Number(row['attempts']),
      nextAttemptAt: optional('next_attempt_at'),
      lastAttemptAt: optional('last_attempt_at'),
      lastStatusCode: row['last_status_code'] == null ? null : Number(row['last_status_code']),
      lastError: optional('last_error'),
      deliveredAt: optional('delivered_at'),
      createdAt: String(row['created_at']),
    };
  }

  private asAdmin<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return work();
    });
  }
}
