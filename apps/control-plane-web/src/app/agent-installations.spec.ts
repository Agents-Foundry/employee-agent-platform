import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AgentInstallations } from './agent-installations';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('agent installations', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('installs a blueprint with only organization-scoped settings and retires by version', async () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(AgentInstallations),
      http = TestBed.inject(HttpTestingController),
      component = fixture.componentInstance;
    const installation = {
      id: 'installation-1',
      name: 'Checkout QA',
      blueprintId: 'engineering.qa-engineer',
      blueprintVersion: '1.1.0',
      status: 'ACTIVE',
      version: 3,
      configuration: {},
    };
    const load = () => {
      http
        .expectOne(`${API_URL}/catalog/v1/blueprints`)
        .flush([
          { id: 'engineering.qa-engineer', version: '1.1.0', title: 'QA Engineer', latest: true },
        ]);
      http
        .expectOne(`${API_URL}/organization/agent-installations?status=all`)
        .flush([installation]);
    };
    const refreshing = component.refresh();
    load();
    await refreshing;
    expect(component.installations()).toHaveLength(1);

    const selecting = component.selectBlueprint('engineering.qa-engineer@1.1.0');
    http
      .expectOne(`${API_URL}/catalog/v1/blueprints/engineering.qa-engineer/versions/1.1.0`)
      .flush({
        blueprint: {
          id: 'engineering.qa-engineer',
          version: '1.1.0',
          mission: 'Test',
          questionnaire: [
            { id: 'qaUrl', label: 'QA URL', type: 'url', required: true, scope: 'AGENT' },
            {
              id: 'issueTracker',
              label: 'Issue tracker',
              type: 'multiselect',
              required: true,
              scope: 'INSTALLATION',
              options: ['Jira'],
            },
          ],
        },
        skills: [],
        workflows: [],
      });
    await selecting;
    expect(component.installationQuestions(component.bundle()!).map((q) => q.id)).toEqual([
      'issueTracker',
    ]);
    component.name = ' Release QA ';
    component.toggle('issueTracker', 'Jira', true);
    const installing = component.install();
    const created = http.expectOne(`${API_URL}/organization/agent-installations`);
    expect(created.request.body).toEqual({
      name: 'Release QA',
      blueprintId: 'engineering.qa-engineer',
      blueprintVersion: '1.1.0',
      configuration: { issueTracker: ['Jira'] },
    });
    created.flush({});
    await Promise.resolve();
    load();
    await installing;
    expect(component.notice()).toContain('Release QA installed');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const retiring = component.retire(installation as never);
    const retire = http.expectOne(
      `${API_URL}/organization/agent-installations/installation-1/retire`,
    );
    expect(retire.request.body).toEqual({ version: 3 });
    retire.flush({});
    await Promise.resolve();
    load();
    await retiring;
    expect(component.notice()).toContain('retired');
  });
});
