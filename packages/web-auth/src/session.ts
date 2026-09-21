import { inject, Injectable, signal } from '@angular/core';
import {
  HttpBackend,
  HttpClient,
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { firstValueFrom, catchError, throwError } from 'rxjs';
import type { Actor, PublicAuthConfig, UserRole } from '../../contracts/src/index';

export const API_URL =
  typeof location === 'undefined' ||
  !['http:', 'https:'].includes(location.protocol) ||
  location.hostname === 'tauri.localhost'
    ? 'http://localhost:4100/api'
    : ['localhost', '127.0.0.1'].includes(location.hostname)
      ? `${location.protocol}//${location.hostname}:4100/api`
      : `${location.origin}/api`;

@Injectable({ providedIn: 'root' })
export class AuthSession {
  private readonly http = new HttpClient(inject(HttpBackend));
  readonly config = signal<PublicAuthConfig | null>(null);
  readonly actor = signal<Actor | null>(null);
  readonly ready = signal(false);
  readonly error = signal('');
  readonly signingIn = signal(false);
  private role: UserRole = 'EMPLOYEE';

  demoHeaders(): Record<string, string> {
    return {
      'x-actor-id': this.role === 'ADMIN' ? 'admin_demo' : 'employee_qa_demo',
      'x-actor-role': this.role,
      'x-organization-id': 'org_agents_foundry',
    };
  }

  async initialize(role: UserRole): Promise<void> {
    this.role = role;
    try {
      const config = await firstValueFrom(
        this.http.get<PublicAuthConfig>(`${API_URL}/auth/config`),
      );
      this.config.set(config);
      const actor = await firstValueFrom(
        this.http.get<Actor>(`${API_URL}/auth/session`, {
          withCredentials: true,
          headers: config.mode === 'demo' ? this.demoHeaders() : {},
        }),
      );
      this.actor.set(actor);
      this.ready.set(actor.role === role);
      if (actor.role !== role)
        this.error.set(
          `This application requires the ${role.toLowerCase()} role. Sign out and use an assigned account.`,
        );
    } catch (error) {
      if (!(error instanceof HttpErrorResponse && error.status === 401))
        this.error.set(
          'Sign-in is unavailable. Check the API connection and your organization membership.',
        );
    }
  }

  signIn(): void {
    if (
      typeof location !== 'undefined' &&
      (!['http:', 'https:'].includes(location.protocol) ||
        location.hostname === 'tauri.localhost' ||
        '__TAURI_INTERNALS__' in window)
    ) {
      this.error.set(
        'Google sign-in is available in the browser apps. Native system-browser sign-in is not connected yet.',
      );
      return;
    }
    location.assign(`${API_URL}/auth/login?client=${this.role === 'ADMIN' ? 'admin' : 'employee'}`);
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    if (this.signingIn()) return;
    this.signingIn.set(true);
    this.error.set('');
    try {
      const actor = await firstValueFrom(
        this.http.post<Actor>(
          `${API_URL}/auth/password`,
          { email, password },
          { withCredentials: true },
        ),
      );
      this.actor.set(actor);
      this.ready.set(actor.role === this.role);
      if (actor.role !== this.role)
        this.error.set(
          `This application requires the ${this.role.toLowerCase()} role. Sign out and use an assigned account.`,
        );
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 429
          ? 'Too many sign-in attempts. Please try again later.'
          : 'Sign-in failed. Check your email and application password, or contact your administrator.',
      );
    } finally {
      this.signingIn.set(false);
    }
  }

  expire(): void {
    this.ready.set(false);
    this.actor.set(null);
    this.error.set('Your session expired. Sign in again.');
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${API_URL}/auth/logout`, {}, { withCredentials: true }));
      this.ready.set(false);
      this.actor.set(null);
      this.error.set('');
    } catch {
      this.error.set('Sign-out failed. Try again.');
    }
  }
}

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith(`${API_URL}/`)) return next(request);
  const session = inject(AuthSession);
  let headers = request.headers
    .delete('x-actor-id')
    .delete('x-actor-role')
    .delete('x-organization-id');
  if (session.config()?.mode === 'demo')
    for (const [key, value] of Object.entries(session.demoHeaders()))
      headers = headers.set(key, value);
  return next(request.clone({ headers, withCredentials: true })).pipe(
    catchError((error) => {
      if (error instanceof HttpErrorResponse && error.status === 401) session.expire();
      return throwError(() => error);
    }),
  );
};
