import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AgentAdmin } from './agent-admin';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('admin agent setup', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('shows only active employees and reuses the request ID after a failed unchanged submission', async () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(AgentAdmin),
      http = TestBed.inject(HttpTestingController),
      component = fixture.componentInstance;
    const blueprint = {
      id: 'engineering.qa-engineer',
      version: '1.1.0',
      questionnaire: [],
      capabilities: [],
      title: 'QA Engineer',
    };
    const members = [
      {
        id: 'active',
        displayName: 'Active',
        email: 'a@example.com',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
      },
      { id: 'pending', role: 'EMPLOYEE', status: 'INVITED' },
      { id: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    ];
    const load = () => {
      http.expectOne(`${API_URL}/blueprints`).flush([blueprint]);
      http.expectOne(`${API_URL}/organization/members`).flush(members);
      http.expectOne(`${API_URL}/organization/agents`).flush([]);
      http.expectOne(`${API_URL}/organization/agent-installations`).flush([]);
    };
    const refreshing = component.refresh();
    load();
    await refreshing;
    expect(component.recipients().map((member) => member.id)).toEqual(['active']);
    component.name = 'Release QA';
    component.provider = 'test';
    component.model = 'model';
    component.selected = ['active'];
    const first = component.create();
    const firstRequest = http.expectOne(`${API_URL}/organization/agents`);
    const requestId = firstRequest.request.body.requestId;
    expect(firstRequest.request.body.employeeIds).toEqual(['active']);
    expect(firstRequest.request.body.organizationId).toBeUndefined();
    firstRequest.flush({}, { status: 500, statusText: 'Server error' });
    await first;
    const retry = component.create();
    const secondRequest = http.expectOne(`${API_URL}/organization/agents`);
    expect(secondRequest.request.body.requestId).toBe(requestId);
    secondRequest.flush([{ agentId: 'created' }]);
    await Promise.resolve();
    load();
    await retry;
    expect(component.selected).toEqual([]);
    expect(component.notice()).toContain('1 agent assignment');
  });

  it('creates from an installation with only the per-agent answers', async () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(AgentAdmin),
      http = TestBed.inject(HttpTestingController),
      component = fixture.componentInstance;
    const blueprint = {
      id: 'engineering.qa-engineer',
      version: '1.1.0',
      title: 'QA Engineer',
      capabilities: [],
      questionnaire: [
        { id: 'qaUrl', label: 'QA URL', type: 'url', required: true },
        {
          id: 'issueTracker',
          label: 'Tracker',
          type: 'multiselect',
          required: true,
          options: ['Jira'],
        },
      ],
    };
    const installation = {
      id: 'installation-1',
      name: 'Checkout QA',
      blueprintId: 'engineering.qa-engineer',
      blueprintVersion: '1.1.0',
      configuration: { issueTracker: ['Jira'] },
    };
    const refreshing = component.refresh();
    http.expectOne(`${API_URL}/blueprints`).flush([blueprint]);
    http
      .expectOne(`${API_URL}/organization/members`)
      .flush([{ id: 'active', role: 'EMPLOYEE', status: 'ACTIVE' }]);
    http.expectOne(`${API_URL}/organization/agents`).flush([]);
    http.expectOne(`${API_URL}/organization/agent-installations`).flush([installation]);
    await refreshing;
    component.installationId = 'installation-1';
    expect(component.agentQuestions(blueprint as never).map((q) => q.id)).toEqual(['qaUrl']);
    component.name = 'Checkout agent';
    component.provider = 'test';
    component.model = 'model';
    component.selected = ['active'];
    component.answers = { qaUrl: 'https://qa.example.com', issueTracker: ['Jira'] };
    const creating = component.create();
    const post = http.expectOne(`${API_URL}/organization/agents`);
    expect(post.request.body.installationId).toBe('installation-1');
    expect(post.request.body.answers).toEqual({ qaUrl: 'https://qa.example.com' });
    post.flush({}, { status: 500, statusText: 'Server error' });
    await creating;
  });
});
