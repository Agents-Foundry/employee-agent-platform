import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AlertWebhooks } from './alert-webhooks';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('alert webhooks', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const base = `${API_URL}/organization/alert-webhooks`;
  const webhook = {
    id: '3f1e2d4c-5b6a-4789-8a0b-1c2d3e4f5a6b',
    displayUrl: 'https://hooks.example.com/…ab12',
    description: 'Finance on-call',
    status: 'ACTIVE',
    version: 2,
    createdBy: 'employee-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'employee-1',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
  const delivery = (status: string, attempts: number, lastError: string | null) => ({
    id: crypto.randomUUID(),
    webhookId: webhook.id,
    eventType: 'model.budget.alert',
    alertId: '0d9f7a3e-6f55-4a1f-8a0e-2a4b7c9d1e22',
    status,
    attempts,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastStatusCode: null,
    lastError,
    deliveredAt: null,
    createdAt: '2026-09-20T00:00:00.000Z',
  });
  const list = {
    webhooks: [webhook],
    deliveries: [
      delivery('DELIVERED', 1, null),
      delivery('PENDING', 2, 'WEBHOOK_TIMEOUT'),
      delivery('FAILED', 6, 'WEBHOOK_HTTP_503'),
    ],
    signingKey: { keyId: 'a'.repeat(64), algorithm: 'Ed25519', publicKeySpki: 'MCowBQYDK2VwAyEA' },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function open() {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(AlertWebhooks),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return { fixture, http, component: fixture.componentInstance };
  }

  it('lists endpoints, the signing key and recent deliveries', async () => {
    const { fixture, http } = open();
    http.expectOne(base).flush(list);
    await settle();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('https://hooks.example.com/…ab12');
    expect(text).toContain('Finance on-call');
    expect(text).toContain('MCowBQYDK2VwAyEA');
    expect(text).toContain('Delivered · 1 attempt');
    expect(text).toContain('Retrying · 2 attempts · last: WEBHOOK_TIMEOUT');
    expect(text).toContain('Failed · 6 attempts · last: WEBHOOK_HTTP_503');
  });

  it('adds, disables and tests endpoints', async () => {
    const { http, component } = open();
    http.expectOne(base).flush(list);
    await settle();

    component.url = ' https://hooks.example.com/new ';
    component.description = 'Ops';
    const adding = component.create();
    const post = http.expectOne(base);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ url: 'https://hooks.example.com/new', description: 'Ops' });
    post.flush(webhook);
    await settle();
    http.expectOne(base).flush(list);
    await adding;
    expect(component.notice()).toBe('Endpoint added.');
    expect(component.url).toBe('');

    const disabling = component.toggle(webhook as never);
    const put = http.expectOne(`${base}/${webhook.id}`);
    expect(put.request.body).toEqual({ status: 'DISABLED', version: 2 });
    put.flush({ ...webhook, status: 'DISABLED', version: 3 });
    await settle();
    http.expectOne(base).flush(list);
    await disabling;
    expect(component.notice()).toContain('Deliveries wait until it is enabled');

    const testing = component.test(webhook as never);
    http
      .expectOne(`${base}/${webhook.id}/test`)
      .flush({ error: 'ALERT_WEBHOOK_DISABLED' }, { status: 409, statusText: 'Conflict' });
    await testing;
    expect(component.error()).toContain('The test was not queued');
  });

  it('explains when the operator has not turned delivery on', async () => {
    const { fixture, http, component } = open();
    http.expectOne(base).flush({ error: 'NOT_FOUND' }, { status: 404, statusText: 'Not Found' });
    await settle();
    fixture.detectChanges();
    expect(component.unavailable()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('ALERT_WEBHOOKS_ENABLED');
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('shows nothing and loads nothing outside password mode', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'demo' });
    const fixture = TestBed.createComponent(AlertWebhooks);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });
});
