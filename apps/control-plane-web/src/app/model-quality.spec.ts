import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ModelQuality } from './model-quality';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('model quality', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const url = `${API_URL}/catalog/v1/quality`;
  const point = (runAt: string, passRate: number, meanScore: number) => ({
    runId: runAt,
    runAt,
    trials: 3,
    passRate,
    meanScore,
  });
  const series = (overrides: object) => ({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    judgeModel: 'claude-opus-5-5',
    blueprint: 'engineering.qa-engineer@1.2.0',
    task: 'file-defect',
    runs: [point('2026-09-14T06:00:00.000Z', 1, 0.9), point('2026-09-21T06:00:00.000Z', 1, 0.9)],
    latest: point('2026-09-21T06:00:00.000Z', 1, 0.9),
    baseline: { runs: 1, passRate: 1, meanScore: 0.9 },
    status: 'STEADY',
    reasons: [],
    ...overrides,
  });
  const overview = {
    since: '2026-04-01T12:00:00.000Z',
    lastImportedAt: '2026-09-29T08:00:00.000Z',
    series: [
      series({ model: 'steady-model' }),
      series({
        model: 'claude-haiku-4-5',
        status: 'REGRESSED',
        reasons: ['pass rate 100% → 33%'],
        latest: point('2026-09-21T06:00:00.000Z', 1 / 3, 0.6),
        runs: [
          point('2026-09-14T06:00:00.000Z', 1, 0.9),
          point('2026-09-21T06:00:00.000Z', 1 / 3, 0.6),
        ],
      }),
      series({
        blueprint: 'engineering.code-reviewer@1.0.0',
        task: 'review',
        status: 'NEW',
        baseline: null,
        runs: [point('2026-09-21T06:00:00.000Z', 1, 0.8)],
      }),
    ],
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function open() {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(ModelQuality),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return { fixture, http, component: fixture.componentInstance };
  }

  it('shows each model per role task, regressions first, and filters by role', async () => {
    const { fixture, http, component } = open();
    http.expectOne(url).flush(overview);
    await settle();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(
      [...element.querySelectorAll('h3')].map((heading) => heading.textContent?.trim()),
    ).toEqual([
      'engineering.code-reviewer@1.0.0 · review',
      'engineering.qa-engineer@1.2.0 · file-defect',
    ]);
    const rows = [...element.querySelectorAll('table')[1]!.querySelectorAll('tbody tr')];
    expect(rows.map((row) => row.querySelector('td')?.textContent?.trim())).toEqual([
      'anthropic/claude-haiku-4-5 (claude-opus-5-5)',
      'anthropic/steady-model (claude-opus-5-5)',
    ]);
    expect(rows[0]!.textContent).toContain('Regressed');
    expect(rows[0]!.textContent).toContain('pass rate 100% → 33%');
    expect(rows[0]!.textContent).toContain('33% of 3 passed · 0.60');
    expect(rows[0]!.querySelector('.spark')?.textContent).toBe('█▅');
    expect(rows[0]!.querySelector('.spark')?.getAttribute('aria-label')).toBe(
      'Mean scores, oldest first: 0.90, 0.60',
    );
    expect(element.textContent).toContain('New');
    expect(component.roles()).toEqual([
      'engineering.code-reviewer@1.0.0',
      'engineering.qa-engineer@1.2.0',
    ]);

    component.role = 'engineering.code-reviewer@1.0.0';
    fixture.detectChanges();
    expect(element.querySelectorAll('h3')).toHaveLength(1);
  });

  it('explains how results arrive when there are none, and reports load failures', async () => {
    const { fixture, http, component } = open();
    http.expectOne(url).flush({ ...overview, lastImportedAt: null, series: [] });
    await settle();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('npm run db:import-quality');

    const retry = component.refresh();
    http.expectOne(url).flush({ error: 'X' }, { status: 500, statusText: 'Error' });
    await retry;
    expect(component.error()).toContain('Could not load model quality');
  });

  it('shows nothing and loads nothing outside password mode', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'demo' });
    const fixture = TestBed.createComponent(ModelQuality);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });
});
