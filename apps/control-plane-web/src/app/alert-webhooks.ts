import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AlertWebhook,
  AlertWebhookDelivery,
  AlertWebhookList,
} from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

/**
 * Alert webhooks (ADR 0024): HTTPS endpoints that receive the organization's model budget
 * alerts, signed with the control plane's key, and what was recently delivered to them.
 */
@Component({
  selector: 'af-alert-webhooks',
  imports: [FormsModule, DatePipe],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="webhooks-heading">
      <h2 id="webhooks-heading">Alert webhooks</h2>
      @if (unavailable()) {
        <p>
          Webhook delivery is turned off for this control plane. An operator can turn it on with
          <code>ALERT_WEBHOOKS_ENABLED</code>. Alerts still appear under Model spending.
        </p>
      } @else {
        <p>
          Each model budget alert is sent as a JSON <code>POST</code> to every active endpoint.
          Requests are signed with the key below, and there is no shared secret: verify the
          <code>af-webhook-signature</code> header and drop repeats of the same
          <code>af-webhook-id</code>.
        </p>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        @if (notice()) {
          <p role="status">{{ notice() }}</p>
        }
        @if (list(); as data) {
          <p class="key">
            <span>Signing key (Ed25519) · {{ data.signingKey.keyId.slice(0, 16) }}…</span>
            <code>{{ data.signingKey.publicKeySpki }}</code>
          </p>
          @for (webhook of data.webhooks; track webhook.id) {
            <p class="row">
              <span
                >{{ webhook.displayUrl }}
                @if (webhook.description) {
                  <small>{{ webhook.description }}</small>
                }
              </span>
              <small>
                {{ webhook.status === 'ACTIVE' ? 'Active' : 'Disabled' }}
                @if (webhook.status === 'ACTIVE') {
                  <button type="button" (click)="test(webhook)" [disabled]="busy()">
                    Send test
                  </button>
                }
                <button type="button" (click)="toggle(webhook)" [disabled]="busy()">
                  {{ webhook.status === 'ACTIVE' ? 'Disable' : 'Enable' }}
                </button>
              </small>
            </p>
          } @empty {
            <p>No endpoints yet.</p>
          }
          @if (data.deliveries.length) {
            <h3>Recent deliveries</h3>
            @for (delivery of data.deliveries; track delivery.id) {
              <p class="row">
                <span
                  >{{ delivery.eventType === 'webhook.test' ? 'Test' : 'Budget alert' }} ·
                  {{ endpoint(delivery) }}</span
                >
                <small>{{ outcome(delivery) }} · {{ delivery.createdAt | date: 'medium' }}</small>
              </p>
            }
          }
        }
        <form #webhookForm="ngForm" (ngSubmit)="webhookForm.valid && create()">
          <h3>Add an endpoint</h3>
          <label
            >HTTPS URL<input
              name="url"
              type="url"
              required
              maxlength="500"
              pattern="https://.+"
              [(ngModel)]="url"
              placeholder="https://hooks.example.com/agents-foundry"
              [disabled]="busy()"
            /><small
              >The default port only; private and internal hosts are refused. The full URL is not
              shown again once saved.</small
            ></label
          >
          <label
            >Description<input
              name="description"
              maxlength="200"
              [(ngModel)]="description"
              placeholder="Finance on-call"
              [disabled]="busy()"
          /></label>
          <button type="submit" [disabled]="busy() || !webhookForm.valid">Add endpoint</button>
        </form>
      }
    </section>
  }`,
  styles: [
    `
      section {
        background: white;
        border: 1px solid #dce4ef;
        border-radius: 16px;
        padding: 24px;
        margin: 24px 0;
        color: #243552;
      }
      h2 {
        margin-top: 0;
      }
      p {
        font-size: 13px;
        line-height: 1.6;
      }
      .key {
        display: grid;
        gap: 4px;
      }
      .key code {
        overflow-wrap: anywhere;
        font-size: 12px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px;
        margin: 0;
        padding: 8px 0;
        border-bottom: 1px solid #e0e7f0;
      }
      .row span {
        display: grid;
        overflow-wrap: anywhere;
      }
      form {
        display: grid;
        gap: 14px;
        margin-top: 20px;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
      }
      input {
        box-sizing: border-box;
        min-width: 0;
        width: 100%;
        padding: 11px;
        border: 1px solid #cbd7e6;
        border-radius: 8px;
      }
      button {
        justify-self: start;
        padding: 10px 14px;
        border: 1px solid #bbcce0;
        border-radius: 8px;
        background: #edf4fd;
        color: #254c7c;
        cursor: pointer;
      }
      .row button {
        margin-left: 8px;
        padding: 4px 10px;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      small {
        color: #60728b;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class AlertWebhooks implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  private readonly base = `${API_URL}/organization/alert-webhooks`;
  readonly list = signal<AlertWebhookList | null>(null);
  readonly unavailable = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  url = '';
  description = '';

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  async refresh() {
    try {
      this.list.set(await firstValueFrom(this.http.get<AlertWebhookList>(this.base)));
      this.unavailable.set(false);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404) this.unavailable.set(true);
      else this.error.set('Could not load alert webhooks. Refresh and try again.');
    }
  }

  endpoint(delivery: AlertWebhookDelivery) {
    return (
      this.list()?.webhooks.find((webhook) => webhook.id === delivery.webhookId)?.displayUrl ??
      'Unknown endpoint'
    );
  }

  outcome(delivery: AlertWebhookDelivery) {
    const tries = `${delivery.attempts} ${delivery.attempts === 1 ? 'attempt' : 'attempts'}`;
    if (delivery.status === 'DELIVERED') return `Delivered · ${tries}`;
    const last = delivery.lastError ? ` · last: ${delivery.lastError}` : '';
    if (delivery.status === 'FAILED') return `Failed · ${tries}${last}`;
    return delivery.attempts ? `Retrying · ${tries}${last}` : 'Queued';
  }

  async create() {
    await this.submit(
      async () => {
        await firstValueFrom(
          this.http.post<AlertWebhook>(this.base, {
            url: this.url.trim(),
            description: this.description.trim(),
          }),
        );
        this.url = '';
        this.description = '';
      },
      'Endpoint added.',
      'The endpoint was not added. Use a public HTTPS URL on the default port, without a user name or fragment.',
    );
  }

  async toggle(webhook: AlertWebhook) {
    const status = webhook.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    await this.submit(
      () =>
        firstValueFrom(
          this.http.put<AlertWebhook>(`${this.base}/${webhook.id}`, {
            status,
            version: webhook.version,
          }),
        ),
      status === 'ACTIVE'
        ? 'Endpoint enabled. Waiting deliveries will be sent.'
        : 'Endpoint disabled. Deliveries wait until it is enabled.',
      'The endpoint was not changed. Someone may have changed it, so refresh and try again.',
    );
  }

  async test(webhook: AlertWebhook) {
    await this.submit(
      () => firstValueFrom(this.http.post(`${this.base}/${webhook.id}/test`, {})),
      'Test delivery queued. It is sent within a minute.',
      'The test was not queued. The endpoint may have been disabled, so refresh and try again.',
    );
  }

  private async submit(work: () => Promise<unknown>, success: string, failure: string) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await work();
      this.notice.set(success);
      await this.refresh();
    } catch {
      this.error.set(failure);
    } finally {
      this.busy.set(false);
    }
  }
}
