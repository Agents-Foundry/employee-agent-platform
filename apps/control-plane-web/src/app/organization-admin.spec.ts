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
