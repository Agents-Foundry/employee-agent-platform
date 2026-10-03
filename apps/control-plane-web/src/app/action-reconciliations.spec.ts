import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActionReconciliations } from './action-reconciliations';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('action reconciliations', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const base = `${API_URL}/organization/action-reconciliations`;
  const open = {
    requestId: '6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b',
    runId: 'run-7',
    threadId: 'thread-3',
    stepId: 'step-2',
    action: 'jira.issue.create',
    target: { type: 'issue-tracker.project', id: 'QA' },
    summary: 'Create Jira bug in QA: Cart total ignores the discount',
    reason: 'CONNECTOR_OUTCOME_UNKNOWN',
    state: 'REQUIRED',
    createdAt: '2026-10-02T10:00:00.000Z',
  };
  const resolved = {
    ...open,
    requestId: '0d9f7a3e-6f55-4a1f-8a0e-2a4b7c9d1e22',
    action: 'repository.pull_request.create',
    target: { type: 'repository', id: 'acme/checkout' },
    summary: null,
    reason: 'DISPATCH_INTERRUPTED',
    state: 'APPLIED',
    resolvedBy: 'employee-1',
    resolvedAt: '2026-10-02T11:00:00.000Z',
    note: 'PR 12 exists',
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function render() {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(ActionReconciliations),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return { fixture, http, component: fixture.componentInstance };
  }
  const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.textContent!;
  const buttons = (fixture: { nativeElement: HTMLElement }) =>
    [...fixture.nativeElement.querySelectorAll('button')].map((button) =>
      button.textContent!.trim(),
    );

  it('shows what is waiting: action, target, request summary, run, time, reason and state', async () => {
    const { fixture, http } = render();
    http.expectOne(base).flush([open, resolved]);
    await settle();
    fixture.detectChanges();
    const shown = text(fixture);
    expect(shown).toContain('1 waiting');
    expect(shown).toContain('jira.issue.create');
    expect(shown).toContain('issue-tracker.project · QA');
    expect(shown).toContain('Create Jira bug in QA: Cart total ignores the discount');
    expect(shown).toContain('run-7');
    expect(shown).toContain('thread-3');
    expect(shown).toContain('did not confirm the request');
    expect(shown).toContain('Waiting for you');
    // What the outcomes mean is stated where they are chosen.
    expect(shown).toContain('you verified the action happened');
    expect(shown).toContain('you verified it did not happen');
    // The resolved one: who, when, and that no summary is shown when none can be written.
    expect(shown).toContain('Verified applied');
    expect(shown).toContain('PR 12 exists');
    expect(shown).toContain('The control plane stopped while it was sending the request.');
    expect(shown).toContain('No summary can be shown for this request.');
  });

  it('offers exactly two verified outcomes and never a retry', async () => {
    const { fixture, http } = render();
    http.expectOne(base).flush([open, resolved]);
    await settle();
    fixture.detectChanges();
    // One open write: two choices. The resolved one offers nothing.
    expect(buttons(fixture)).toEqual(['Verified applied…', 'Verified not applied…']);
    expect(buttons(fixture).join(' ')).not.toMatch(/retry|resend|again/i);
  });

  it('sends nothing until the administrator confirms they checked, then resolves once', async () => {
    const { fixture, http, component } = render();
    http.expectOne(base).flush([open]);
    await settle();
    fixture.detectChanges();

    component.choose(open as never, 'NOT_APPLIED');
    fixture.detectChanges();
    http.expectNone(`${base}/${open.requestId}/resolution`);
    expect(text(fixture)).toContain('did not happen in the external system');
    expect(text(fixture)).toContain('This cannot be changed afterwards.');
    const submit = fixture.nativeElement.querySelector(
      'form button[type=submit]',
    ) as HTMLButtonElement;
    await fixture.whenStable();
    fixture.detectChanges();
    expect(submit.disabled).toBe(true);
    // Without the explicit confirmation nothing is sent.
    await component.confirm();
    http.expectNone(`${base}/${open.requestId}/resolution`);

    component.verified = true;
    component.note = '  Searched QA: no such issue  ';
    const confirming = component.confirm();
    const post = http.expectOne(`${base}/${open.requestId}/resolution`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      resolution: 'NOT_APPLIED',
      note: 'Searched QA: no such issue',
    });
    post.flush({ ...open, state: 'NOT_APPLIED' });
    await settle();
    http.expectOne(base).flush([{ ...open, state: 'NOT_APPLIED' }]);
    await confirming;
    fixture.detectChanges();
    expect(component.notice()).toContain('Recorded as not applied');
    expect(component.pending()).toBeNull();
    expect(buttons(fixture)).toEqual([]);
  });

  it('cancels without sending, and explains when someone else resolved it first', async () => {
    const { http, component } = render();
    http.expectOne(base).flush([open]);
    await settle();

    component.choose(open as never, 'APPLIED');
    component.cancel();
    expect(component.pending()).toBeNull();
    http.expectNone(`${base}/${open.requestId}/resolution`);

    component.choose(open as never, 'APPLIED');
    component.verified = true;
    const confirming = component.confirm();
    const post = http.expectOne(`${base}/${open.requestId}/resolution`);
    expect(post.request.body).toEqual({ resolution: 'APPLIED' });
    post.flush({ error: 'RECONCILIATION_RESOLVED' }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne(base).flush([{ ...open, state: 'NOT_APPLIED' }]);
    await confirming;
    expect(component.error()).toContain('already recorded an outcome');
  });

  it('shows nothing and loads nothing outside password mode', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'demo' });
    const fixture = TestBed.createComponent(ActionReconciliations);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });
});
