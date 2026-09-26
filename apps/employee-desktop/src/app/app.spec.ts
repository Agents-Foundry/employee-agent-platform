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

  it('follows a generic-runtime QA run until it ends and reloads the conversation', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    const api = 'http://localhost:4100/api';
    App.followIntervalMs = 1;
    fixture.detectChanges();
    http.expectOne(`${api}/bootstrap`).flush({
      organization: { id: 'org' },
      employee: { id: 'employee', organizationId: 'org' },
      agents: [{ id: 'agent_qa_engineer', name: 'QA', status: 'ACTIVE' }],
    });
    await fixture.whenStable();
    http.expectOne(`${api}/blueprints`).flush([]);
    await fixture.whenStable();
    http.expectOne(`${api}/provisioning`).flush([]);
    await fixture.whenStable();
    await vi.waitFor(() => http.expectOne((req) => req.url.endsWith('/conversations')).flush([]));
    await fixture.whenStable();

    const conversation = {
      id: 'conversation-1',
      employeeId: 'employee',
      agentId: 'agent_qa_engineer',
      title: 'QA-7',
      messages: [],
    };
    (
      fixture.componentInstance as unknown as { activeConversation: { set(v: unknown): void } }
    ).activeConversation.set(conversation);
    const submitted = (
      fixture.componentInstance as unknown as { submit(): Promise<void> }
    ).submit();
    http.expectOne(`${api}/conversations/conversation-1/messages`).flush({});
    await vi.waitFor(() => {
      const start = http.expectOne(`${api}/qa/runs`);
      expect(start.request.body.instructions).toContain('Analyze the story');
      start.flush({
        mode: 'GENERIC_RUNTIME',
        agentRun: { id: 'run-1', threadId: 'thread-1', status: 'QUEUED' },
      });
    });
    await vi.waitFor(() =>
      http.expectOne(`${api}/conversations/conversation-1`).flush(conversation),
    );
    await vi.waitFor(() => http.expectOne((req) => req.url.endsWith('/conversations')).flush([]));
    const detail = (status: string, steps: object[], approvals: object[]) => ({
      run: {
        id: 'run-1',
        status,
        statusReason: null,
        task: { objective: 'x', workflow: 'validate-story', workItem: { key: 'QA-7' }, inputs: {} },
      },
      steps,
      approvals,
      artifacts: [],
    });
    await vi.waitFor(() =>
      http
        .expectOne(`${api}/execution/v1/runs/run-1`)
        .flush(
          detail(
            'WAITING_FOR_APPROVAL',
            [{ id: 's1', title: 'Tool call: browser', status: 'WAITING_FOR_APPROVAL' }],
            [
              {
                id: 'abcdef1234',
                action: 'qa.execute_playwright',
                risk: 'MEDIUM',
                status: 'PENDING',
              },
            ],
          ),
        ),
    );
    await submitted;
    await fixture.whenStable();
    fixture.detectChanges();
    const text = () => fixture.nativeElement.textContent as string;
    expect(text()).toContain('validate-story QA-7');
    expect(text()).toContain('Waiting for approval abcdef12');
    expect(text()).toContain('Cancel run');

    await vi.waitFor(() =>
      http
        .expectOne(`${api}/execution/v1/runs/run-1`)
        .flush(
          detail('COMPLETED', [{ id: 's1', title: 'Tool call: browser', status: 'COMPLETED' }], []),
        ),
    );
    await vi.waitFor(() =>
      http.expectOne(`${api}/conversations/conversation-1`).flush({
        ...conversation,
        messages: [
          {
            id: 'm1',
            author: 'AGENT',
            content: 'QA-7 validated.',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(text()).toContain('QA-7 validated.');
    expect(text()).not.toContain('Cancel run');
    await new Promise((resolve) => setTimeout(resolve, 20));
    http.expectNone(`${api}/execution/v1/runs/run-1`);
    http.verify();
    App.followIntervalMs = 2000;
  });
});
