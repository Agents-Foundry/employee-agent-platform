import { Component, inject } from '@angular/core';
import { AuthSession } from './session';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'af-auth-panel',
  imports: [FormsModule],
  template: ` <section class="sign-in">
    <h1>Agents Foundry</h1>
    @if (auth.error()) {
      <p role="alert">{{ auth.error() }}</p>
    }
    @if (auth.config()?.mode === 'google') {
      <form (ngSubmit)="submit()">
        <label for="login-email">Email</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autocomplete="username"
          required
          maxlength="254"
          [(ngModel)]="email"
          [disabled]="auth.signingIn()"
        />
        <label for="login-password">Application password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="256"
          [(ngModel)]="password"
          [disabled]="auth.signingIn()"
        />
        <button type="submit" [disabled]="auth.signingIn() || !email || !password">
          {{ auth.signingIn() ? 'Signing in…' : 'Sign in with email' }}
        </button>
      </form>
      <p>
        Use your administrator-provided application password, not your Google password. Contact your
        administrator to set or reset it.
      </p>
      <p>Or continue with your assigned Workspace account.</p>
      <button (click)="auth.signIn()">Sign in with Google</button>
      @if (auth.actor()) {
        <button (click)="auth.signOut()">Sign out</button>
      }
    } @else if (!auth.config()) {
      <p>Connecting to the control plane…</p>
    }
  </section>`,
  styles: [
    `
      .sign-in {
        max-width: 460px;
        margin: 12vh auto;
        padding: 32px;
        font-family: system-ui;
        border: 1px solid #d7dce6;
        border-radius: 16px;
      }
      button {
        padding: 12px 18px;
        margin: 8px;
        cursor: pointer;
      }
      label,
      input {
        display: block;
        width: 100%;
        box-sizing: border-box;
      }
      label {
        margin-top: 16px;
        margin-bottom: 6px;
      }
      input {
        padding: 12px;
        border: 1px solid #aeb8ca;
        border-radius: 6px;
        font: inherit;
      }
    `,
  ],
})
export class AuthPanel {
  readonly auth = inject(AuthSession);
  email = '';
  password = '';
  async submit(): Promise<void> {
    const password = this.password;
    this.password = '';
    await this.auth.signInWithPassword(this.email, password);
  }
}
