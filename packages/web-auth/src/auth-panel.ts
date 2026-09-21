import { Component, inject } from '@angular/core';
import { AuthSession } from './session';

@Component({
  selector: 'af-auth-panel',
  template: ` <section class="sign-in">
    <h1>Agents Foundry</h1>
    @if (auth.error()) {
      <p role="alert">{{ auth.error() }}</p>
    }
    @if (auth.config()?.mode === 'google') {
      <p>Use your assigned Google Workspace account to continue.</p>
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
    `,
  ],
})
export class AuthPanel {
  readonly auth = inject(AuthSession);
}
