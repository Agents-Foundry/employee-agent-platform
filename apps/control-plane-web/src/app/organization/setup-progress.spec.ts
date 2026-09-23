import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_URL, AuthSession } from '../../../../../packages/web-auth/src/session';
import { SetupProgress } from './setup-progress';

describe('organization setup progress', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('shows server-computed steps and refreshes without sending tenant identifiers', () => {
    TestBed.inject(AuthSession).config.set({ mode: 'password' });
    const fixture = TestBed.createComponent(SetupProgress);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    const request = http.expectOne(`${API_URL}/organization/setup-progress`);
    expect(request.request.method).toBe('GET');
    expect(request.request.params.keys()).toEqual([]);
    request.flush({
      completedRequired: 1,
      totalRequired: 6,
      steps: [
        { id: 'profile', required: true, complete: true },
        { id: 'structure', required: true, complete: false },
        { id: 'domain', required: false, complete: false },
      ],
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1 of 6 required steps complete');
    expect(fixture.nativeElement.querySelector('a[href="#organization-structure"]')).toBeTruthy();
    fixture.componentInstance.load();
    http
      .expectOne(`${API_URL}/organization/setup-progress`)
      .flush({ completedRequired: 2, totalRequired: 6, steps: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('2 of 6 required steps complete');
  });
});
