import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';
import { vi } from 'vitest';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('shows admin-assigned agents without provisioning requests and refuses an invalid manifest', async () => {
    const fixture = TestBed.createComponent(App),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('http://localhost:4100/api/bootstrap').flush({
      organization: { id: 'org' },
      employee: { id: 'employee', organizationId: 'org' },
      agents: [{ id: 'assigned-agent', name: 'Release QA', status: 'ACTIVE' }],
    });
    await fixture.whenStable();
    http.expectOne('http://localhost:4100/api/blueprints').flush([]);
    await fixture.whenStable();
    http.expectOne('http://localhost:4100/api/provisioning').flush([]);
    await fixture.whenStable();
    await vi.waitFor(() => http.expectOne((req) => req.url.endsWith('/conversations')).flush([]));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Release QA');
    const select = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.includes('Verify and use agent'))!;
    select.click();
    http.expectOne('http://localhost:4100/api/agents/assigned-agent/manifest').flush({});
    http.expectOne('http://localhost:4100/api/manifest-key').flush({});
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('could not be verified');
    http.expectNone((req) => req.method === 'POST');
    http.verify();
  });

  it('renders blueprint questions and submits an employee request with its answers', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('http://localhost:4100/api/bootstrap').flush({
      organization: { id: 'org_agents_foundry' },
      employee: { id: 'employee_qa_demo', organizationId: 'org_agents_foundry' },
      agents: [],
    });
    await fixture.whenStable();
    http.expectOne('http://localhost:4100/api/blueprints').flush([
      {
        id: 'engineering.qa-engineer',
        version: '1.1.0',
        title: 'QA Engineer',
        mission: 'Quality',
        questionnaire: [{ id: 'projectName', label: 'Project name', type: 'text', required: true }],
      },
    ]);
    await fixture.whenStable();
    http.expectOne('http://localhost:4100/api/provisioning').flush([]);
    await fixture.whenStable();
    await vi.waitFor(() => http.expectOne((req) => req.url.endsWith('/conversations')).flush([]));
    await fixture.whenStable();
    fixture.detectChanges();
    for (const [name, value] of [
      ['projectName', 'Pilot'],
      ['provider', 'test-provider'],
      ['model', 'test-model'],
    ]) {
      const input = fixture.nativeElement.querySelector(
        `input[name="${name}"]`,
      ) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    await fixture.whenStable();
    fixture.nativeElement
      .querySelector('.provisioning-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const submitted = http.expectOne('http://localhost:4100/api/provisioning');
    expect(submitted.request.method).toBe('POST');
    expect(submitted.request.headers.get('x-actor-id')).toBe('employee_qa_demo');
    expect(submitted.request.body.answers).toEqual({ projectName: 'Pilot' });
    expect(submitted.request.body.blueprintVersion).toBe('1.1.0');
    submitted.flush({});
    await fixture.whenStable();
    await vi.waitFor(() =>
      http
        .expectOne('http://localhost:4100/api/provisioning')
        .flush([{ id: 'request-1', status: 'PENDING', answers: { projectName: 'Pilot' } }]),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Pilot · PENDING');
    http.verify();
  });
});
