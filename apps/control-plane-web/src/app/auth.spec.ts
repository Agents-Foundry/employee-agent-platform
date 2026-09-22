import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthSession, API_URL, authInterceptor } from '../../../../packages/web-auth/src/session';
import { AuthPanel } from '../../../../packages/web-auth/src/auth-panel';

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

  it('renders both login methods and clears the password on form submission', async () => {
    const auth = TestBed.inject(AuthSession),
      http = TestBed.inject(HttpTestingController);
    auth.config.set({ mode: 'google', workspaceDomain: 'example.com' });
    const fixture = TestBed.createComponent(AuthPanel);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[type="password"]').autocomplete).toBe(
      'current-password',
    );
    expect(fixture.nativeElement.textContent).toContain('Sign in with Google');
    fixture.componentInstance.email = 'employee@example.com';
    fixture.componentInstance.password = 'a unique long passphrase';
    const submitted = fixture.componentInstance.submit();
    expect(fixture.componentInstance.password).toBe('');
    http
      .expectOne(`${API_URL}/auth/password`)
      .flush({ id: 'admin', role: 'ADMIN', organizationId: 'org' });
    await submitted;
    expect(auth.ready()).toBe(false);
    expect(auth.error()).toContain('employee role');
  });

  it('signs in with a password using cookies and displays a generic failure or throttling message', async () => {
    const auth = TestBed.inject(AuthSession),
      http = TestBed.inject(HttpTestingController);
    const attempt = auth.signInWithPassword('employee@example.com', 'long test password');
    expect(auth.signingIn()).toBe(true);
    const login = http.expectOne(`${API_URL}/auth/password`);
    expect(login.request.withCredentials).toBe(true);
    expect(login.request.body).toEqual({
      email: 'employee@example.com',
      password: 'long test password',
    });
    login.flush({ id: 'employee', role: 'EMPLOYEE', organizationId: 'org' });
    await attempt;
    expect(auth.ready()).toBe(true);
    expect(auth.signingIn()).toBe(false);
    auth.expire();
    const failure = auth.signInWithPassword('employee@example.com', 'wrong');
    http
      .expectOne(`${API_URL}/auth/password`)
      .flush({}, { status: 401, statusText: 'Unauthorized' });
    await failure;
    expect(auth.ready()).toBe(false);
    expect(auth.error()).toContain('Sign-in failed');
    const throttled = auth.signInWithPassword('employee@example.com', 'wrong');
    http
      .expectOne(`${API_URL}/auth/password`)
      .flush({}, { status: 429, statusText: 'Too Many Requests' });
    await throttled;
    expect(auth.error()).toContain('Too many');
  });

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
