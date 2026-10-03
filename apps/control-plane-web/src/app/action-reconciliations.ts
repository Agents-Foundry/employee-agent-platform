import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { ActionReconciliation } from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

type Resolution = 'APPLIED' | 'NOT_APPLIED';

const REASONS: Record<ActionReconciliation['reason'], string> = {
  CONNECTOR_OUTCOME_UNKNOWN:
    'The external system did not confirm the request: no answer, a server error, or an answer that could not be read.',
  DISPATCH_INTERRUPTED: 'The control plane stopped while it was sending the request.',
};

/**
 * Writes whose outcome is unknown (ADR 0036, ADR 0039). The platform never guesses and never
 * sends such a write again: an administrator checks the external system and records what it
 * shows, once. There is deliberately no retry here; after `NOT_APPLIED` the agent may ask again
 * through the Action Gateway, with its normal policy and approval.
 */
@Component({
  selector: 'af-action-reconciliations',
  imports: [FormsModule, DatePipe],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="reconciliation-heading">
      <h2 id="reconciliation-heading">
        Writes to reconcile
        @if (open().length) {
          <span class="count">{{ open().length }} waiting</span>
        }
      </h2>
      <p>
        These governed writes may or may not have happened in the external system. Until you record
        what it shows, the platform refuses the same action in that conversation, and the same
        request anywhere in the organization. Check the external system first, then record exactly
        one outcome:
      </p>
      <ul class="meaning">
        <li>
          <strong>Applied</strong>: you verified the action happened (for example, the issue or pull
          request exists).
        </li>
        <li>
          <strong>Not applied</strong>: you verified it did not happen. The agent may then request
          it again, under the usual policy and approval.
        </li>
      </ul>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      @for (item of items(); track item.requestId) {
        <article class="item" [class.resolved]="item.state !== 'REQUIRED'">
          <header>
            <strong>{{ item.action }}</strong>
            <span class="state">{{ stateLabel(item) }}</span>
          </header>
          <dl>
            <dt>Target</dt>
            <dd>{{ item.target ? item.target.type + ' · ' + item.target.id : 'Not recorded' }}</dd>
            <dt>Request</dt>
            <dd>{{ item.summary ?? 'No summary can be shown for this request.' }}</dd>
            <dt>Why it is unknown</dt>
            <dd>{{ reason(item) }}</dd>
            <dt>Run</dt>
            <dd>
              <code>{{ item.runId }}</code> · conversation <code>{{ item.threadId }}</code>
            </dd>
            <dt>When</dt>
            <dd>{{ item.createdAt | date: 'medium' }}</dd>
            @if (item.state !== 'REQUIRED') {
              <dt>Resolved</dt>
              <dd>
                {{ item.resolvedAt | date: 'medium' }} by <code>{{ item.resolvedBy }}</code>
                @if (item.note) {
                  · {{ item.note }}
                }
              </dd>
            }
          </dl>
          @if (item.state === 'REQUIRED') {
            @if (pending()?.item?.requestId === item.requestId) {
              <form class="confirm" (ngSubmit)="confirm()" aria-label="Confirm the outcome">
                <p>
                  @if (pending()!.resolution === 'APPLIED') {
                    Record that you verified <strong>{{ item.action }}</strong> happened in the
                    external system. The platform will not send it again.
                  } @else {
                    Record that you verified <strong>{{ item.action }}</strong> did not happen in
                    the external system. The agent may request it again, under the usual policy and
                    approval.
                  }
                  This cannot be changed afterwards.
                </p>
                <label
                  >What you checked (optional)<input
                    name="note"
                    maxlength="500"
                    [(ngModel)]="note"
                    placeholder="Searched the QA project: no such issue"
                    [disabled]="busy()"
                /></label>
                <label class="check"
                  ><input
                    name="verified"
                    type="checkbox"
                    [(ngModel)]="verified"
                    [disabled]="busy()"
                  />I checked the external system myself</label
                >
                <span class="actions">
                  <button type="submit" class="primary" [disabled]="busy() || !verified">
                    Confirm {{ pending()!.resolution === 'APPLIED' ? 'applied' : 'not applied' }}
                  </button>
                  <button type="button" (click)="cancel()" [disabled]="busy()">Cancel</button>
                </span>
              </form>
            } @else {
              <span class="actions">
                <button type="button" (click)="choose(item, 'APPLIED')" [disabled]="busy()">
                  Verified applied…
                </button>
                <button type="button" (click)="choose(item, 'NOT_APPLIED')" [disabled]="busy()">
                  Verified not applied…
                </button>
              </span>
            }
          }
        </article>
      } @empty {
        @if (loaded()) {
          <p>No writes are waiting to be reconciled.</p>
        }
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
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .count {
        font-size: 12px;
        padding: 2px 10px;
        border-radius: 999px;
        background: #fdecea;
        color: #8a2a1d;
      }
      p,
      li,
      dd,
      dt {
        font-size: 13px;
        line-height: 1.6;
      }
      .item {
        border-top: 1px solid #e0e7f0;
        padding: 14px 0;
        display: grid;
        gap: 8px;
      }
      .item header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px;
      }
      .item.resolved {
        opacity: 0.75;
      }
      .state {
        font-size: 12px;
        color: #60728b;
      }
      dl {
        display: grid;
        grid-template-columns: minmax(110px, max-content) 1fr;
        gap: 4px 14px;
        margin: 0;
      }
      dt {
        color: #60728b;
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      code {
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .confirm {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px solid #f0d2a8;
        border-radius: 10px;
        background: #fff8ee;
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 13px;
      }
      .check {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      input:not([type='checkbox']) {
        box-sizing: border-box;
        min-width: 0;
        width: 100%;
        padding: 9px;
        border: 1px solid #cbd7e6;
        border-radius: 8px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      button {
        padding: 8px 12px;
        border: 1px solid #bbcce0;
        border-radius: 8px;
        background: #edf4fd;
        color: #254c7c;
        cursor: pointer;
      }
      button.primary {
        background: #254c7c;
        color: white;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      @media (max-width: 560px) {
        dl {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class ActionReconciliations implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  private readonly base = `${API_URL}/organization/action-reconciliations`;
  readonly items = signal<ActionReconciliation[]>([]);
  readonly open = computed(() => this.items().filter((item) => item.state === 'REQUIRED'));
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly pending = signal<{ item: ActionReconciliation; resolution: Resolution } | null>(null);
  note = '';
  verified = false;

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  async refresh() {
    try {
      this.items.set(await firstValueFrom(this.http.get<ActionReconciliation[]>(this.base)));
      this.loaded.set(true);
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 403
          ? 'Only organization administrators can see writes to reconcile.'
          : 'Could not load writes to reconcile. Refresh and try again.',
      );
    }
  }

  reason(item: ActionReconciliation) {
    return REASONS[item.reason] ?? item.reason;
  }

  stateLabel(item: ActionReconciliation) {
    return item.state === 'REQUIRED'
      ? 'Waiting for you'
      : item.state === 'APPLIED'
        ? 'Verified applied'
        : 'Verified not applied';
  }

  /** The first step only: nothing is sent until the administrator confirms. */
  choose(item: ActionReconciliation, resolution: Resolution) {
    if (item.state !== 'REQUIRED') return;
    this.pending.set({ item, resolution });
    this.note = '';
    this.verified = false;
    this.error.set('');
    this.notice.set('');
  }

  cancel() {
    this.pending.set(null);
    this.note = '';
    this.verified = false;
  }

  async confirm() {
    const pending = this.pending();
    if (!pending || !this.verified || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    const note = this.note.trim();
    try {
      await firstValueFrom(
        this.http.post<ActionReconciliation>(`${this.base}/${pending.item.requestId}/resolution`, {
          resolution: pending.resolution,
          ...(note ? { note } : {}),
        }),
      );
      this.notice.set(
        pending.resolution === 'APPLIED'
          ? 'Recorded as applied. The platform will not send it again.'
          : 'Recorded as not applied. The agent may request it again under the usual policy.',
      );
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 409
          ? 'Someone has already recorded an outcome for this write. The list has been refreshed.'
          : 'The outcome was not recorded. Refresh and try again.',
      );
    } finally {
      this.pending.set(null);
      this.note = '';
      this.verified = false;
      this.busy.set(false);
    }
    await this.refresh();
  }
}
