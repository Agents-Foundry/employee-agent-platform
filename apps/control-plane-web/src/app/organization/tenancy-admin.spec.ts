import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthSession, API_URL } from '../../../../../packages/web-auth/src/session';
import { TenantAdmin } from './tenant-admin';
import { PeopleAdmin } from './people-admin';

describe('tenant and people administration forms', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('saves a versioned tenant profile and shows the DNS proof from the server', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(TenantAdmin),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne(`${API_URL}/organization/profile`).flush({
      id: 'org',
      name: 'Acme',
      legalName: '',
      code: 'ACME',
      slug: 'acme',
      website: '',
      industry: '',
      country: '',
      timezone: 'UTC',
      locale: 'en',
      status: 'active',
      version: 1,
      updatedAt: 'now',
    });
    http.expectOne(`${API_URL}/organization/domains`).flush([]);
    const component = fixture.componentInstance;
    component.form.controls.name.setValue('Acme Incorporated');
    component.save();
    const save = http.expectOne(`${API_URL}/organization/profile`);
    expect(save.request.body).toEqual({
      name: 'Acme Incorporated',
      legalName: '',
      code: 'ACME',
      slug: 'acme',
      website: '',
      industry: '',
      country: '',
      timezone: 'UTC',
      locale: 'en',
      version: 1,
    });
    expect(save.request.body.organizationId).toBeUndefined();
    save.flush({ ...save.request.body, id: 'org', version: 2, status: 'active', updatedAt: 'now' });
    component.domain = 'agents.acme.com';
    component.register();
    const domain = http.expectOne(`${API_URL}/organization/domains`);
    expect(domain.request.body).toEqual({ domain: 'agents.acme.com', domainType: 'custom_domain' });
    domain.flush({ id: 'domain' });
    http.expectOne(`${API_URL}/organization/domains`).flush([
      {
        id: 'domain',
        domain: 'agents.acme.com',
        domainType: 'custom_domain',
        isPrimary: false,
        verificationStatus: 'pending',
        verificationToken: 'af-verify=test',
        verifiedAt: null,
        version: 1,
      },
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      '_agents-foundry-verification.agents.acme.com',
    );
    expect(fixture.nativeElement.textContent).toContain('af-verify=test');
  });
  it('creates an employee without an account and assigns a position with concurrency version', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(PeopleAdmin),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http
      .expectOne((req) => req.url === `${API_URL}/organization/employees` && req.method === 'GET')
      .flush({ items: [], total: 0, page: 1, pageSize: 25 });
    http
      .expectOne((req) => req.url === `${API_URL}/organization/memberships` && req.method === 'GET')
      .flush({ items: [], total: 0, page: 1, pageSize: 25 });
    const component = fixture.componentInstance;
    component.form.setValue({
      displayName: 'Ada Engineer',
      email: 'ada@example.com',
      employeeNumber: 'E42',
      employmentType: 'employee',
    });
    component.save();
    const create = http.expectOne(`${API_URL}/organization/employees`);
    expect(create.request.body).toEqual({
      displayName: 'Ada Engineer',
      email: 'ada@example.com',
      employeeNumber: 'E42',
      employmentType: 'employee',
    });
    const employee = {
      ...create.request.body,
      id: 'employee',
      organizationId: 'org',
      userId: null,
      employmentStatus: 'active',
      version: 1,
      positionId: null,
      positionTitle: null,
      unitName: null,
      roleName: null,
      levelName: null,
    };
    create.flush(employee);
    http
      .expectOne((req) => req.url === `${API_URL}/organization/employees` && req.method === 'GET')
      .flush({ items: [employee], total: 1, page: 1, pageSize: 25 });
    expect(component.notice()).toContain('Invite them separately');
    component.assign('position');
    const assign = http.expectOne(`${API_URL}/organization/employees/employee/position`);
    expect(assign.request.body).toEqual({ positionId: 'position', version: 1 });
    assign.flush({ ...employee, version: 2, positionId: 'position', positionTitle: 'Senior QA' });
    http
      .expectOne((req) => req.url === `${API_URL}/organization/employees` && req.method === 'GET')
      .flush({ items: [], total: 0, page: 1, pageSize: 25 });
    expect(component.selected()?.positionTitle).toBe('Senior QA');
  });
});
