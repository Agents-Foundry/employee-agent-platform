import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { StructureAdmin } from './structure-admin';
import { RecordPicker } from './record-picker';
import { AuthSession, API_URL } from '../../../../../packages/web-auth/src/session';
import type { OrganizationUnit } from '../../../../../packages/contracts/src/organization';

describe('organization structure administration', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('loads bounded tree pages and saves without client-supplied tenant or actor identifiers', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(StructureAdmin),
      http = TestBed.inject(HttpTestingController),
      component = fixture.componentInstance;
    fixture.detectChanges();
    const list = http.expectOne((req) => req.url === `${API_URL}/organization/units`);
    expect(list.request.params.get('pageSize')).toBe('25');
    expect(list.request.params.get('parentId')).toBe('root');
    list.flush({ items: [], total: 0, page: 1, pageSize: 25 });
    component.form.setValue({
      name: 'Engineering',
      code: 'ENG',
      unitType: 'department',
      parentId: null,
      description: '',
    });
    component.save();
    const save = http.expectOne(`${API_URL}/organization/units`);
    expect(save.request.body.organizationId).toBeUndefined();
    expect(save.request.body.createdBy).toBeUndefined();
    const unit: OrganizationUnit = {
      ...save.request.body,
      id: 'unit',
      organizationId: 'organization',
      status: 'active',
      version: 1,
      createdAt: 'now',
      updatedAt: 'now',
    };
    save.flush(unit);
    http
      .expectOne((req) => req.url.endsWith('/unit/members'))
      .flush({ items: [], total: 0, page: 1, pageSize: 25 });
    http
      .expectOne((req) => req.url === `${API_URL}/organization/units`)
      .flush({ items: [unit], total: 1, page: 1, pageSize: 25 });
    expect(component.notice()).toBe('Structure saved.');
    component.save();
    const edit = http.expectOne(`${API_URL}/organization/units/unit`);
    expect(edit.request.method).toBe('PUT');
    expect(edit.request.body.version).toBe(1);
    edit.flush({ error: 'UNIT_VERSION_CONFLICT' }, { status: 409, statusText: 'Conflict' });
    expect(component.error()).toContain('Refresh and reopen');
    expect(component.busy()).toBe(false);
  });
  it('requires explicit archive confirmation and searches records on the server', () => {
    const fixture = TestBed.createComponent(StructureAdmin),
      http = TestBed.inject(HttpTestingController);
    fixture.componentInstance.archive();
    http.expectNone((req) => req.method === 'POST');
    const picker = TestBed.createComponent(RecordPicker);
    picker.componentRef.setInput('url', `${API_URL}/organization/units/employee-options`);
    picker.componentRef.setInput('label', 'Find employee');
    picker.componentInstance.search = 'John';
    picker.componentInstance.find();
    const search = http.expectOne((req) => req.url.endsWith('/employee-options'));
    expect(search.request.params.get('search')).toBe('John');
    expect(search.request.params.get('pageSize')).toBe('10');
    search.flush({ items: [], total: 0, page: 1, pageSize: 10 });
    picker.detectChanges();
    expect(picker.nativeElement.textContent).toContain('No matches in your organization');
  });
});
