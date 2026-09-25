import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActionGovernance } from './action-governance';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('action governance', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const connection = {
    id: 'connection-1',
    provider: 'jira',
    name: 'Alpha Jira',
    baseUrl: 'https://alpha.atlassian.net',
    secretRef: 'secret://jira-token',
    settings: { allowedProjects: ['QA'] },
    status: 'ACTIVE',
    version: 2,
  };
  const action = {
    action: 'jira.issue.create',
    defaultOutcome: 'REQUIRE_APPROVAL',
    risk: 'MEDIUM',
    executedBy: 'CONTROL_PLANE',
    connectorProvider: 'jira',
    override: null,
  };

  it('adds connections by reference, disables by version and tightens policy', async () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(ActionGovernance),
      http = TestBed.inject(HttpTestingController),
      component = fixture.componentInstance;
    const load = () => {
      http.expectOne(`${API_URL}/organization/connector-connections`).flush([connection]);
      http.expectOne(`${API_URL}/organization/action-policies`).flush([action]);
    };
    // First render runs ngOnInit, which loads connections and policies.
    fixture.detectChanges();
    load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('secret://jira-token');
    expect(fixture.nativeElement.textContent).toContain('performed by the platform');

    component.name = ' Beta Jira ';
    component.baseUrl = 'https://beta.atlassian.net';
    component.secretRef = 'secret://beta-token';
    component.projects = 'qa, WEB, qa';
    const connecting = component.connect();
    const created = http.expectOne(`${API_URL}/organization/connector-connections`);
    expect(created.request.body).toEqual({
      provider: 'jira',
      name: 'Beta Jira',
      baseUrl: 'https://beta.atlassian.net',
      secretRef: 'secret://beta-token',
      settings: { allowedProjects: ['QA', 'WEB'] },
    });
    created.flush({});
    await Promise.resolve();
    load();
    await connecting;
    expect(component.notice()).toContain('Beta Jira connected');
    expect(component.name).toBe('');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const disabling = component.disable(connection as never);
    const disable = http.expectOne(
      `${API_URL}/organization/connector-connections/connection-1/disable`,
    );
    expect(disable.request.body).toEqual({ version: 2 });
    disable.flush({});
    await Promise.resolve();
    load();
    await disabling;

    vi.spyOn(window, 'prompt').mockReturnValue(' Change freeze ');
    const tightening = component.tighten(action as never, 'DENY');
    const put = http.expectOne(`${API_URL}/organization/action-policies/jira.issue.create`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ outcome: 'DENY', reason: 'Change freeze' });
    put.flush({});
    await Promise.resolve();
    load();
    await tightening;
    expect(component.notice()).toContain('denied');

    const clearing = component.clear(action as never);
    const cleared = http.expectOne(`${API_URL}/organization/action-policies/jira.issue.create`);
    expect(cleared.request.method).toBe('DELETE');
    cleared.flush(null);
    await Promise.resolve();
    load();
    await clearing;
  });

  it('shows an error and keeps the form when the connection is rejected', async () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const component = TestBed.createComponent(ActionGovernance).componentInstance,
      http = TestBed.inject(HttpTestingController);
    component.name = 'Jira';
    const connecting = component.connect();
    http
      .expectOne(`${API_URL}/organization/connector-connections`)
      .flush({ error: 'CONNECTION_URL_INVALID' }, { status: 400, statusText: 'Bad Request' });
    await connecting;
    expect(component.error()).toContain('HTTPS');
    expect(component.name).toBe('Jira');
  });
});
