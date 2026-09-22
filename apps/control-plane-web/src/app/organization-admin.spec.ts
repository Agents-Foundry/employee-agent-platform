import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { OrganizationAdmin } from './organization-admin';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

describe('organization administration', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('selects invitation reissue for expired invites and password recovery for active members', () => {
    const fixture = TestBed.createComponent(OrganizationAdmin),
      http = TestBed.inject(HttpTestingController);
    const component = fixture.componentInstance;
    const member = {
      id: 'member',
      displayName: 'Employee',
      email: 'employee@example.com',
      role: 'EMPLOYEE',
      team: 'QA',
      status: 'INVITATION_EXPIRED',
    };
    component.recover(member);
    const reissue = http.expectOne(`${API_URL}/organization/members/member/recovery-link`);
    expect(reissue.request.body).toEqual({ purpose: 'activate' });
    reissue.flush({
      activationUrl: 'http://localhost:4300/#activate=test',
      expiresAt: Date.now() + 3600000,
    });
    http.expectOne(`${API_URL}/organization/members`).flush([]);
    expect(component.linkKind()).toBe('activate');
    component.recover({ ...member, status: 'ACTIVE' });
    const reset = http.expectOne(`${API_URL}/organization/members/member/recovery-link`);
    expect(reset.request.body).toEqual({ purpose: 'reset' });
    reset.flush({
      activationUrl: 'http://localhost:4300/#reset=test',
      expiresAt: Date.now() + 3600000,
    });
    http.expectOne(`${API_URL}/organization/members`).flush([]);
    expect(component.linkKind()).toBe('reset');
    expect(component.busy()).toBe(false);
  });
  it('invites employees without allowing the browser to assign an organization or role', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(OrganizationAdmin),
      http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne(`${API_URL}/organization/members`).flush([]);
    const component = fixture.componentInstance;
    component.name = 'Employee';
    component.email = 'employee@example.com';
    component.team = 'QA';
    component.invite();
    const request = http.expectOne(`${API_URL}/organization/invitations`);
    expect(request.request.body).toEqual({
      displayName: 'Employee',
      email: 'employee@example.com',
      team: 'QA',
    });
    request.flush({ activationUrl: 'http://localhost:4300/#activate=private-test-link' });
    http.expectOne(`${API_URL}/organization/members`).flush([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Email delivery is not connected yet');
    expect(component.link()).toContain('#activate=');
    expect(component.busy()).toBe(false);
  });
});
