import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthSession, API_URL, authInterceptor } from '../../../../packages/web-auth/src/session';

describe('browser authentication boundary', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('waits for the session and sends cookies without demo identity headers in Google mode', async () => {
    const auth = TestBed.inject(AuthSession),
      http = TestBed.inject(HttpTestingController);
    const loading = auth.initialize('ADMIN');
    http
      .expectOne(`${API_URL}/auth/config`)
      .flush({ mode: 'google', workspaceDomain: 'example.com' });
    await Promise.resolve();
    const session = http.expectOne(`${API_URL}/auth/session`);
    expect(session.request.withCredentials).toBe(true);
    expect(auth.ready()).toBe(false);
    session.flush({ id: 'admin-a', organizationId: 'org-a', role: 'ADMIN' });
    await loading;
    expect(auth.ready()).toBe(true);
    TestBed.inject(HttpClient)
      .get(`${API_URL}/bootstrap`, {
        headers: { 'x-actor-role': 'ADMIN', 'x-actor-id': 'spoof', 'x-organization-id': 'other' },
      })
      .subscribe();
    const business = http.expectOne(`${API_URL}/bootstrap`);
    expect(business.request.withCredentials).toBe(true);
    expect(business.request.headers.has('x-actor-id')).toBe(false);
    expect(business.request.headers.has('x-actor-role')).toBe(false);
    business.flush({});
    const logout = auth.signOut();
    http.expectOne(`${API_URL}/auth/logout`).flush(null, { status: 204, statusText: 'No Content' });
    await logout;
    expect(auth.ready()).toBe(false);
    expect(auth.actor()).toBeNull();
  });

  it('keeps the application gated for wrong roles and expired sessions', async () => {
    const auth = TestBed.inject(AuthSession),
      http = TestBed.inject(HttpTestingController);
    const loading = auth.initialize('ADMIN');
    http
      .expectOne(`${API_URL}/auth/config`)
      .flush({ mode: 'google', workspaceDomain: 'example.com' });
    await Promise.resolve();
    http
      .expectOne(`${API_URL}/auth/session`)
      .flush({ id: 'employee-a', organizationId: 'org-a', role: 'EMPLOYEE' });
    await loading;
    expect(auth.ready()).toBe(false);
    expect(auth.error()).toContain('admin role');
    TestBed.inject(HttpClient)
      .get(`${API_URL}/bootstrap`)
      .subscribe({ error: () => {} });
    http.expectOne(`${API_URL}/bootstrap`).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(auth.actor()).toBeNull();
    expect(auth.ready()).toBe(false);
  });

  it('adds demo identity only after the server explicitly advertises demo mode', async () => {
    const auth = TestBed.inject(AuthSession),
      http = TestBed.inject(HttpTestingController);
    const loading = auth.initialize('EMPLOYEE');
    http.expectOne(`${API_URL}/auth/config`).flush({ mode: 'demo' });
    await Promise.resolve();
    const session = http.expectOne(`${API_URL}/auth/session`);
    expect(session.request.headers.get('x-actor-id')).toBe('employee_qa_demo');
    session.flush({
      id: 'employee_qa_demo',
      organizationId: 'org_agents_foundry',
      role: 'EMPLOYEE',
    });
    await loading;
    expect(auth.ready()).toBe(true);
  });
});
