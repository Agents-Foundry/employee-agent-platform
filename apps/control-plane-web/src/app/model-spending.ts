import { Component, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { ModelUsageReport, OrganizationModelBudget } from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

/**
 * Model spending limits (ADR 0021): the organization's monthly and per-run token limits, and
 * this month's usage. The runtime makes no model call the limits do not allow.
 */
@Component({
  selector: 'af-model-spending',
  imports: [FormsModule, DecimalPipe],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="spending-heading">
      <h2 id="spending-heading">Model spending</h2>
      <p>
        Every model call an agent makes is reserved against these limits first. When a limit is
        reached, calls stop and the run fails. Limits are in tokens (input and output) as the model
        provider reports them; months are UTC calendar months.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      @if (usage(); as report) {
        <div class="summary">
          <article>
            <span>Used in {{ report.period }}</span>
            <strong>{{ report.chargedTokens | number }}</strong>
            <small>
              @if (report.budget.monthlyTokenLimit !== null) {
                of {{ report.budget.monthlyTokenLimit | number }} ·
                {{ report.remainingTokens | number }} left
              } @else {
                No monthly limit
              }
            </small>
          </article>
          <article>
            <span>Model calls</span>
            <strong>{{ report.calls | number }}</strong>
            <small
              >{{ report.inputTokens | number }} in · {{ report.outputTokens | number }} out
              @if (report.unsettledReservedTokens) {
                · {{ report.unsettledReservedTokens | number }} reserved, not yet reported
              }
            </small>
          </article>
        </div>
        @if (report.byAgent.length) {
          <h3>By agent</h3>
          @for (row of report.byAgent; track row.agentId) {
            <p class="row">
              <span>{{ row.agentId }}</span
              ><small>{{ row.chargedTokens | number }} tokens · {{ row.calls }} calls</small>
            </p>
          }
          <h3>By model</h3>
          @for (row of report.byModel; track row.provider + row.model) {
            <p class="row">
              <span>{{ row.provider }} · {{ row.model }}</span
              ><small>{{ row.chargedTokens | number }} tokens · {{ row.calls }} calls</small>
            </p>
          }
        }
      }
      <form #budgetForm="ngForm" (ngSubmit)="budgetForm.valid && save()">
        <h3>Limits</h3>
        <label
          >Monthly token limit<input
            name="monthly"
            type="number"
            min="1"
            step="1"
            [(ngModel)]="monthly"
            placeholder="No limit"
            [disabled]="busy()"
        /></label>
        <label
          >Per-run token limit<input
            name="perRun"
            type="number"
            min="1"
            step="1"
            [(ngModel)]="perRun"
            placeholder="No limit"
            [disabled]="busy()"
          /><small>Leave a field empty for no limit.</small></label
        >
        <button type="submit" [disabled]="busy() || loading() || !budgetForm.valid">
          {{ busy() ? 'Saving…' : 'Save limits' }}
        </button>
      </form>
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
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 14px;
      }
      .summary article {
        display: grid;
        gap: 4px;
        padding: 14px;
        border: 1px solid #e0e7f0;
        border-radius: 12px;
      }
      .summary strong {
        font-size: 22px;
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
export class ModelSpending implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly usage = signal<ModelUsageReport | null>(null);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  monthly: number | null = null;
  perRun: number | null = null;
  private version = 0;

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  async refresh() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const report = await firstValueFrom(
        this.http.get<ModelUsageReport>(`${API_URL}/organization/model-usage`),
      );
      this.usage.set(report);
      this.apply(report.budget);
    } catch {
      this.error.set('Could not load model spending. Refresh and try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async save() {
    if (this.busy()) return;
    const limit = (value: number | null) =>
      value === null || (value as unknown) === '' ? null : Math.floor(Number(value));
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const budget = await firstValueFrom(
        this.http.put<OrganizationModelBudget>(`${API_URL}/organization/model-budget`, {
          monthlyTokenLimit: limit(this.monthly),
          runTokenLimit: limit(this.perRun),
          version: this.version,
        }),
      );
      this.apply(budget);
      this.notice.set('Model spending limits saved.');
      await this.refresh();
    } catch {
      this.error.set(
        'The limits were not saved. Use whole numbers above zero; someone may have changed them, so refresh and try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  private apply(budget: OrganizationModelBudget) {
    this.version = budget.version;
    this.monthly = budget.monthlyTokenLimit;
    this.perRun = budget.runTokenLimit;
  }
}
