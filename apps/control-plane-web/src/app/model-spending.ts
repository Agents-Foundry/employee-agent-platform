import { Component, OnInit, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  ModelBudgetAlert,
  ModelBudgetAlertList,
  ModelPrice,
  ModelPriceBook,
  ModelUsageReport,
  OrganizationModelBudget,
} from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

const MICROS = 1_000_000;
/** Currency amounts are entered in whole units and sent in micros. */
const toMicros = (value: number | null) =>
  value === null || (value as unknown) === '' ? null : Math.round(Number(value) * MICROS);
const fromMicros = (value: number | null) => (value === null ? null : value / MICROS);

/**
 * Model spending limits (ADRs 0021 to 0023): the organization's token and cost limits, the
 * prices its cost is counted at, this month's usage and its alerts. The runtime makes no model
 * call the limits do not allow.
 */
@Component({
  selector: 'af-model-spending',
  imports: [FormsModule, DecimalPipe],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="spending-heading">
      <h2 id="spending-heading">Model spending</h2>
      <p>
        Every model call an agent makes is reserved against these limits first. When a limit is
        reached, calls stop and the run fails. Tokens (input and output) are as the model provider
        reports them. Cost is counted at the prices you set below, not from provider bills; months
        are UTC calendar months.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      @for (alert of alerts(); track alert.id) {
        <p class="alert" [class.acknowledged]="alert.acknowledgedAt">
          <span>
            {{ describe(alert) }}
            @if (alert.acknowledgedAt) {
              <small>Acknowledged</small>
            }
          </span>
          @if (!alert.acknowledgedAt) {
            <button type="button" (click)="acknowledge(alert)" [disabled]="busy()">
              Acknowledge
            </button>
          }
        </p>
      }
      @if (usage(); as report) {
        <div class="summary">
          <article>
            <span>Tokens used in {{ report.period }}</span>
            <strong>{{ report.chargedTokens | number }}</strong>
            <small>
              @if (report.budget.monthlyTokenLimit !== null) {
                of {{ report.budget.monthlyTokenLimit | number }} ·
                {{ report.remainingTokens | number }} left
              } @else {
                No monthly token limit
              }
            </small>
          </article>
          <article>
            <span>Cost in {{ report.period }}</span>
            <strong>{{ money(report.chargedCostMicros) }}</strong>
            <small>
              @if (report.budget.monthlyCostLimitMicros !== null) {
                of {{ money(report.budget.monthlyCostLimitMicros) }} ·
                {{ money(report.remainingCostMicros) }} left
              } @else {
                No monthly cost limit
              }
              @if (report.unpricedCalls) {
                · {{ report.unpricedCalls | number }} calls without a price not included
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
              ><small
                >{{ row.chargedTokens | number }} tokens · {{ money(row.chargedCostMicros) }} ·
                {{ row.calls }} calls</small
              >
            </p>
          }
          <h3>By model</h3>
          @for (row of report.byModel; track row.provider + row.model) {
            <p class="row">
              <span>{{ row.provider }} · {{ row.model }}</span
              ><small
                >{{ row.chargedTokens | number }} tokens · {{ money(row.chargedCostMicros) }} ·
                {{ row.calls }} calls</small
              >
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
        /></label>
        <label
          >Currency<input
            name="currency"
            required
            pattern="[A-Z]{3}"
            maxlength="3"
            [(ngModel)]="currency"
            [disabled]="busy() || prices().length > 0"
          /><small>ISO 4217 code, such as USD. It can't change once a price is set.</small></label
        >
        <label
          >Monthly cost limit<input
            name="monthlyCost"
            type="number"
            min="0.000001"
            step="any"
            [(ngModel)]="monthlyCost"
            placeholder="No limit"
            [disabled]="busy()"
        /></label>
        <label
          >Per-run cost limit<input
            name="perRunCost"
            type="number"
            min="0.000001"
            step="any"
            [(ngModel)]="perRunCost"
            placeholder="No limit"
            [disabled]="busy()"
          /><small
            >Leave a field empty for no limit. With a cost limit set, models without a price can't
            be called.</small
          ></label
        >
        <label
          >Alert at (% of the monthly limits)<input
            name="thresholds"
            pattern="\\s*([1-9][0-9]?\\s*(,\\s*[1-9][0-9]?\\s*){0,4})?"
            [(ngModel)]="thresholds"
            placeholder="80, 95"
            [disabled]="busy()"
          /><small
            >Up to five percentages from 1 to 99, separated by commas. Reaching a monthly limit
            always alerts. Alerts appear here; they are not emailed.</small
          ></label
        >
        <button type="submit" [disabled]="busy() || loading() || !budgetForm.valid">
          {{ busy() ? 'Saving…' : 'Save limits' }}
        </button>
      </form>
      <h3>Model prices</h3>
      <p>
        Prices per million tokens, in {{ usage()?.budget?.currency ?? currency }}. Each call is
        costed at the price in effect when it was reserved.
      </p>
      @for (price of prices(); track price.priceId) {
        <p class="row">
          <span>{{ price.provider }} · {{ price.model }}</span
          ><small
            >{{ money(price.inputMicrosPerMillionTokens) }} in ·
            {{ money(price.outputMicrosPerMillionTokens) }} out
            <button type="button" (click)="edit(price)" [disabled]="busy()">Edit</button>
            <button type="button" (click)="remove(price)" [disabled]="busy()">Remove</button></small
          >
        </p>
      } @empty {
        <p>No prices yet.</p>
      }
      <form #priceForm="ngForm" (ngSubmit)="priceForm.valid && savePrice()">
        <label
          >Provider<input
            name="provider"
            required
            pattern="[a-zA-Z0-9._\\-]{1,80}"
            [(ngModel)]="draft.provider"
            placeholder="anthropic"
            [disabled]="busy()"
        /></label>
        <label
          >Model<input
            name="model"
            required
            pattern="[a-zA-Z0-9._:/\\-]{1,160}"
            [(ngModel)]="draft.model"
            [disabled]="busy()"
        /></label>
        <label
          >Input price per million tokens<input
            name="inputPrice"
            type="number"
            required
            min="0"
            step="any"
            [(ngModel)]="draft.input"
            [disabled]="busy()"
        /></label>
        <label
          >Output price per million tokens<input
            name="outputPrice"
            type="number"
            required
            min="0"
            step="any"
            [(ngModel)]="draft.output"
            [disabled]="busy()"
        /></label>
        <button type="submit" [disabled]="busy() || loading() || !priceForm.valid">
          Save price
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
      .alert {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin: 0 0 10px;
        padding: 10px 14px;
        border: 1px solid #e8c77a;
        border-radius: 10px;
        background: #fff8e6;
      }
      .alert.acknowledged {
        border-color: #e0e7f0;
        background: white;
      }
      .alert small {
        margin-left: 8px;
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
export class ModelSpending implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  private readonly currencyPipe = new CurrencyPipe('en-US');
  readonly usage = signal<ModelUsageReport | null>(null);
  readonly prices = signal<ModelPrice[]>([]);
  readonly alerts = signal<ModelBudgetAlert[]>([]);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  monthly: number | null = null;
  perRun: number | null = null;
  currency = 'USD';
  monthlyCost: number | null = null;
  perRunCost: number | null = null;
  thresholds = '';
  draft: { provider: string; model: string; input: number | null; output: number | null } = {
    provider: '',
    model: '',
    input: null,
    output: null,
  };
  private version = 0;

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  /** An amount in micros, in the organization's currency, to the micro when it is small. */
  money(micros: number | null) {
    if (micros === null) return '';
    const code = this.usage()?.budget.currency ?? this.currency;
    return this.currencyPipe.transform(micros / MICROS, code, 'symbol', '1.2-6') ?? '';
  }

  async refresh() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [report, book, alerts] = await Promise.all([
        firstValueFrom(this.http.get<ModelUsageReport>(`${API_URL}/organization/model-usage`)),
        firstValueFrom(this.http.get<ModelPriceBook>(`${API_URL}/organization/model-prices`)),
        firstValueFrom(this.http.get<ModelBudgetAlertList>(`${API_URL}/organization/model-alerts`)),
      ]);
      this.usage.set(report);
      this.prices.set(book.prices);
      this.alerts.set(alerts.alerts);
      this.apply(report.budget);
    } catch {
      this.error.set('Could not load model spending. Refresh and try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async save() {
    const limit = (value: number | null) =>
      value === null || (value as unknown) === '' ? null : Math.floor(Number(value));
    await this.submit(
      async () => {
        const budget = await firstValueFrom(
          this.http.put<OrganizationModelBudget>(`${API_URL}/organization/model-budget`, {
            monthlyTokenLimit: limit(this.monthly),
            runTokenLimit: limit(this.perRun),
            currency: this.currency,
            monthlyCostLimitMicros: toMicros(this.monthlyCost),
            runCostLimitMicros: toMicros(this.perRunCost),
            alertThresholdsPercent: this.thresholds
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
              .map(Number),
            version: this.version,
          }),
        );
        this.apply(budget);
      },
      'Model spending limits saved.',
      'The limits were not saved. Use amounts above zero; someone may have changed them, so refresh and try again.',
    );
  }

  describe(alert: ModelBudgetAlert) {
    const used = (value: number) =>
      alert.scope === 'MONTHLY_COST'
        ? this.money(value)
        : `${value.toLocaleString('en-US')} tokens`;
    const what = alert.scope === 'MONTHLY_COST' ? 'cost' : 'token';
    const head =
      alert.thresholdPercent === 100
        ? `The monthly model ${what} limit is reached`
        : `${alert.thresholdPercent}% of the monthly model ${what} limit is used`;
    return `${head} (${used(alert.charged)} of ${used(alert.limit)}, ${alert.period}).`;
  }

  async acknowledge(alert: ModelBudgetAlert) {
    await this.submit(
      () =>
        firstValueFrom(
          this.http.post<ModelBudgetAlert>(
            `${API_URL}/organization/model-alerts/${alert.id}/acknowledge`,
            {},
          ),
        ),
      'Alert acknowledged.',
      'The alert was not acknowledged. Someone may have acknowledged it already, so refresh.',
    );
  }

  edit(price: ModelPrice) {
    this.draft = {
      provider: price.provider,
      model: price.model,
      input: fromMicros(price.inputMicrosPerMillionTokens),
      output: fromMicros(price.outputMicrosPerMillionTokens),
    };
  }

  async savePrice() {
    const { provider, model } = this.draft;
    // Replacing the price the page shows; a price someone else changed meanwhile is a conflict.
    const current = this.prices().find((p) => p.provider === provider && p.model === model);
    await this.submit(
      async () => {
        await firstValueFrom(
          this.http.put<ModelPrice>(`${API_URL}/organization/model-prices`, {
            provider,
            model,
            inputMicrosPerMillionTokens: toMicros(this.draft.input),
            outputMicrosPerMillionTokens: toMicros(this.draft.output),
            expectedPriceId: current?.priceId ?? null,
          }),
        );
        this.draft = { provider: '', model: '', input: null, output: null };
      },
      `Price for ${model} saved.`,
      'The price was not saved. Check the provider, model and amounts; someone may have changed it, so refresh and try again.',
    );
  }

  async remove(price: ModelPrice) {
    await this.submit(
      () =>
        firstValueFrom(
          this.http.post<void>(`${API_URL}/organization/model-prices/remove`, {
            provider: price.provider,
            model: price.model,
            expectedPriceId: price.priceId,
          }),
        ),
      `Price for ${price.model} removed.`,
      'The price was not removed. Someone may have changed it, so refresh and try again.',
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

  private apply(budget: OrganizationModelBudget) {
    this.version = budget.version;
    this.monthly = budget.monthlyTokenLimit;
    this.perRun = budget.runTokenLimit;
    this.currency = budget.currency;
    this.monthlyCost = fromMicros(budget.monthlyCostLimitMicros);
    this.perRunCost = fromMicros(budget.runCostLimitMicros);
    this.thresholds = budget.alertThresholdsPercent.join(', ');
  }
}
