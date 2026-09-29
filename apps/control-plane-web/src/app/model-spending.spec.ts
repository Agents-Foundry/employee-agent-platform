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
    version: 3,
    updatedBy: 'employee-1',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  const report = {
    period: '2026-09',
    budget,
    chargedTokens: 250_000,
    calls: 12,
    inputTokens: 200_000,
    outputTokens: 40_000,
    unsettledReservedTokens: 10_000,
    remainingTokens: 750_000,
    byAgent: [{ agentId: 'agent-1', chargedTokens: 250_000, calls: 12 }],
    byModel: [{ provider: 'anthropic', model: 'claude', chargedTokens: 250_000, calls: 12 }],
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('shows usage against the limits and saves limits with the current version', async () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(ModelSpending),
      http = TestBed.inject(HttpTestingController),
      component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${API_URL}/organization/model-usage`).flush(report);
    await settle();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('250,000');
    expect(text).toContain('750,000 left');
    expect(text).toContain('10,000 reserved, not yet reported');
    expect(text).toContain('anthropic · claude');
    expect(component.monthly).toBe(1_000_000);
    expect(component.perRun).toBeNull();

    component.monthly = 2_000_000.7;
    component.perRun = 50_000;
    const saving = component.save();
    const put = http.expectOne(`${API_URL}/organization/model-budget`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      monthlyTokenLimit: 2_000_000,
      runTokenLimit: 50_000,
      version: 3,
    });
    put.flush({ ...budget, monthlyTokenLimit: 2_000_000, runTokenLimit: 50_000, version: 4 });
    await settle();
    http.expectOne(`${API_URL}/organization/model-usage`).flush({
      ...report,
      budget: { ...budget, monthlyTokenLimit: 2_000_000, runTokenLimit: 50_000, version: 4 },
    });
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

  it('shows nothing and loads nothing outside password mode', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'demo' });
    const fixture = TestBed.createComponent(ModelSpending);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });
});
