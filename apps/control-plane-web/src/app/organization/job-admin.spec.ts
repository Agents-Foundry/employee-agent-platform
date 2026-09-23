import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { JobAdmin } from './job-admin';
import { API_URL } from '../../../../../packages/web-auth/src/session';
describe('job architecture editor', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('requires position dependencies and submits job configuration without security roles', () => {
    const component = TestBed.createComponent(JobAdmin).componentInstance,
      http = TestBed.inject(HttpTestingController);
    component.kind = 'positions';
    component.form.setValue({
      name: 'Senior QA',
      code: 'SQA',
      description: 'Test automation',
      rank: 0,
    });
    expect(component.valid()).toBe(false);
    component.references = { organizationalUnitId: 'unit', roleId: 'role', jobLevelId: 'level' };
    expect(component.valid()).toBe(true);
    component.save();
    const save = http.expectOne(`${API_URL}/organization/jobs/positions`);
    expect(save.request.body).toEqual({
      name: 'Senior QA',
      code: 'SQA',
      description: 'Test automation',
      organizationalUnitId: 'unit',
      roleId: 'role',
      jobLevelId: 'level',
      reportsToPositionId: null,
    });
    save.flush({ error: 'JOB_DEPENDENCY_CONFLICT' }, { status: 409, statusText: 'Conflict' });
    expect(component.error()).toContain('reporting line forms a cycle');
    expect(component.busy()).toBe(false);
  });
});
