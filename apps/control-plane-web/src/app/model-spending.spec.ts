import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ModelSpending } from './model-spending';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('model spending', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const budget = {
    monthlyTokenLimit: 1_000_000,
    runTokenLimit: null,
    currency: 'USD',
    monthlyCostLimitMicros: 250_000_000,
    runCostLimitMicros: null,
    version: 3,
    updatedBy: 'employee-1',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  const totals = { chargedTokens: 250_000, chargedCostMicros: 1_234_500, calls: 12 };
  const report = {
    period: '2026-09',
    budget,
    ...totals,
    unpricedCalls: 2,
    inputTokens: 200_000,
    outputTokens: 40_000,
    unsettledReservedTokens: 10_000,
    remainingTokens: 750_000,
    remainingCostMicros: 248_765_500,
    byAgent: [{ agentId: 'agent-1', ...totals, unpricedCalls: 2 }],
    byModel: [{ provider: 'anthropic', model: 'claude', ...totals, unpricedCalls: 2 }],
  };
  const price = {
    priceId: '7a1c1a52-45a4-4a51-9d49-5f0f2d7c3a10',
    provider: 'anthropic',
    model: 'claude',
    currency: 'USD',
    inputMicrosPerMillionTokens: 3_000_000,
    outputMicrosPerMillionTokens: 15_000_000,
    setBy: 'employee-1',
    setAt: '2026-09-01T00:00:00.000Z',
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function open() {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(ModelSpending),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return { fixture, http, component: fixture.componentInstance };
  }
  async function load(
    http: HttpTestingController,
    usage: object = report,
    prices: object[] = [price],
  ) {
    http.expectOne(`${API_URL}/organization/model-usage`).flush(usage);
    http.expectOne(`${API_URL}/organization/model-prices`).flush({ currency: 'USD', prices });
    await settle();
  }

  it('shows usage against the limits and saves limits with the current version', async () => {
    const { fixture, http, component } = open();
    await load(http);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('250,000');
    expect(text).toContain('750,000 left');
    expect(text).toContain('10,000 reserved, not yet reported');
    expect(text).toContain('anthropic · claude');
    expect(text).toContain('$1.2345');
    expect(text).toContain('of $250.00 · $248.7655 left');
    expect(text).toContain('2 calls without a price not included');
    expect(text).toContain('$3.00 in · $15.00 out');
    expect(component.monthly).toBe(1_000_000);
    expect(component.perRun).toBeNull();
    expect(component.monthlyCost).toBe(250);

    component.monthly = 2_000_000.7;
    component.perRun = 50_000;
    component.perRunCost = 2.5;
    const saving = component.save();
    const put = http.expectOne(`${API_URL}/organization/model-budget`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      monthlyTokenLimit: 2_000_000,
      runTokenLimit: 50_000,
      currency: 'USD',
      monthlyCostLimitMicros: 250_000_000,
      runCostLimitMicros: 2_500_000,
      version: 3,
    });
    const saved = { ...budget, monthlyTokenLimit: 2_000_000, runTokenLimit: 50_000, version: 4 };
    put.flush(saved);
    await settle();
    await load(http, { ...report, budget: saved });
    await saving;
    expect(component.notice()).toBe('Model spending limits saved.');

    // A conflict is reported, not retried.
    const conflict = component.save();
    http
      .expectOne(`${API_URL}/organization/model-budget`)
      .flush({ error: 'VERSION_CONFLICT' }, { status: 409, statusText: 'Conflict' });
    await conflict;
    expect(component.error()).toContain('refresh and try again');
  });

  it('replaces a shown price with its id, adds new prices and removes them', async () => {
    const { http, component } = open();
    await load(http);

    component.edit(price);
    expect(component.draft).toEqual({
      provider: 'anthropic',
      model: 'claude',
      input: 3,
      output: 15,
    });
    component.draft.output = 12.5;
    const replacing = component.savePrice();
    const put = http.expectOne(`${API_URL}/organization/model-prices`);
    expect(put.request.body).toEqual({
      provider: 'anthropic',
      model: 'claude',
      inputMicrosPerMillionTokens: 3_000_000,
      outputMicrosPerMillionTokens: 12_500_000,
      expectedPriceId: price.priceId,
    });
    put.flush({ ...price, priceId: 'b3f0c7c4-3f5b-4f0c-9a53-0b7d8a1e2c11' });
    await settle();
    await load(http);
    await replacing;
    expect(component.notice()).toBe('Price for claude saved.');

    component.draft = { provider: 'anthropic', model: 'claude-haiku', input: 0.8, output: 4 };
    const adding = component.savePrice();
    const add = http.expectOne(`${API_URL}/organization/model-prices`);
    expect(add.request.body).toMatchObject({
      inputMicrosPerMillionTokens: 800_000,
      expectedPriceId: null,
    });
    add.flush({ error: 'VERSION_CONFLICT' }, { status: 409, statusText: 'Conflict' });
    await adding;
    expect(component.error()).toContain('The price was not saved');

    const removing = component.remove(price);
    const post = http.expectOne(`${API_URL}/organization/model-prices/remove`);
    expect(post.request.body).toEqual({
      provider: 'anthropic',
      model: 'claude',
      expectedPriceId: price.priceId,
    });
    post.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await load(http, report, []);
    await removing;
    expect(component.notice()).toBe('Price for claude removed.');
    expect(component.prices()).toEqual([]);
  });

  it('shows nothing and loads nothing outside password mode', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'demo' });
    const fixture = TestBed.createComponent(ModelSpending);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });
});
