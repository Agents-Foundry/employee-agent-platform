// Alert webhooks (ADR 0024): the control plane POSTs each model budget alert to an
// organization's endpoints, signed with its Ed25519 key. Receivers verify the signature with
// the pinned public key; there is no shared secret.

import type { ModelBudgetAlert } from './model-spending.js';

export const WEBHOOK_SIGNATURE_KIND = 'agents-foundry/webhook/v1';

/** Request headers of every delivery. */
export const WEBHOOK_HEADERS = {
  /** The delivery id: the same across retries, so receivers can drop duplicates. */
  id: 'af-webhook-id',
  /** Unix seconds when this attempt was signed; receivers should reject old ones. */
  timestamp: 'af-webhook-timestamp',
  keyId: 'af-webhook-key-id',
  /** `ed25519=<base64 signature>` over `webhookSigningInput`. */
  signature: 'af-webhook-signature',
} as const;

/**
 * The exact bytes signed for a delivery attempt: domain-separated from manifests, execution
 * grants and every other document the key signs.
 */
export function webhookSigningInput(deliveryId: string, timestamp: number, body: string): string {
  return `${WEBHOOK_SIGNATURE_KIND}\n${deliveryId}\n${timestamp}\n${body}`;
}

export type WebhookEventType = 'model.budget.alert' | 'webhook.test';

/** The JSON body of a delivery. Identical bytes are sent on every retry. */
export type WebhookEvent =
  | {
      type: 'model.budget.alert';
      deliveryId: string;
      organizationId: string;
      createdAt: string;
      data: { alert: ModelBudgetAlert };
    }
  | {
      type: 'webhook.test';
      deliveryId: string;
      organizationId: string;
      createdAt: string;
      data: { message: string };
    };

export interface AlertWebhook {
  id: string;
  /**
   * The endpoint's origin and a masked path: URLs can carry tokens, so the full URL is never
   * returned after it is set.
   */
  displayUrl: string;
  description: string;
  status: 'ACTIVE' | 'DISABLED';
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AlertWebhookDelivery {
  id: string;
  webhookId: string;
  eventType: WebhookEventType;
  alertId: string | null;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  /** HTTP status of the last attempt, when a response arrived. */
  lastStatusCode: number | null;
  /** Error code of the last failed attempt, such as `WEBHOOK_TIMEOUT`. */
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface AlertWebhookList {
  webhooks: AlertWebhook[];
  /** The most recent deliveries, newest first. */
  deliveries: AlertWebhookDelivery[];
  /** The key deliveries are signed with; receivers pin it. */
  signingKey: { keyId: string; algorithm: 'Ed25519'; publicKeySpki: string };
}

/** `POST /api/organization/alert-webhooks`. */
export interface AlertWebhookInput {
  url: string;
  description: string;
}

/** `PUT /api/organization/alert-webhooks/:id`. */
export interface AlertWebhookStatusInput {
  status: 'ACTIVE' | 'DISABLED';
  version: number;
}
