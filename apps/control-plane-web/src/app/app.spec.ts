import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { App } from './app';

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

  it('shows provisioning permissions and sends a reasoned admin decision', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http
      .expectOne('http://localhost:4100/api/bootstrap')
      .flush({ organization: { id: 'org_agents_foundry' }, agents: [] });
    http.expectOne('http://localhost:4100/api/approvals').flush([]);
    http.expectOne('http://localhost:4100/api/provisioning').flush([
      {
        id: 'request-1',
        status: 'PENDING',
        employeeId: 'employee_qa_demo',
        answers: { projectName: 'Pilot' },
        blueprintId: 'engineering.qa-engineer',
        blueprintVersion: '1.1.0',
        capabilities: [{ action: 'qa.execute_playwright', outcome: 'REQUIRE_APPROVAL' }],
      },
    ]);
    http.expectOne('http://localhost:4100/api/lifecycle-events').flush([]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('REQUIRE_APPROVAL');
    const input = fixture.nativeElement.querySelector(
      'input[name="request-1"]',
    ) as HTMLInputElement;
    input.value = 'Approved for pilot';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.provisioning-request .approve').click();
    const decision = http.expectOne('http://localhost:4100/api/provisioning/request-1/decision');
    expect(decision.request.headers.get('x-actor-role')).toBe('ADMIN');
    expect(decision.request.body).toEqual({ decision: 'APPROVED', reason: 'Approved for pilot' });
    decision.flush({});
    http
      .expectOne('http://localhost:4100/api/bootstrap')
      .flush({ organization: { id: 'org_agents_foundry' }, agents: [] });
    http.expectOne('http://localhost:4100/api/approvals').flush([]);
    http.expectOne('http://localhost:4100/api/provisioning').flush([]);
    http.expectOne('http://localhost:4100/api/lifecycle-events').flush([]);
    http.verify();
  });
});
