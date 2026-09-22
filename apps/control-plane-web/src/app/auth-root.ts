import { Component, inject, OnInit } from '@angular/core';
import { App } from './app';
import { AuthSession } from '../../../../packages/web-auth/src/session';
import { AuthPanel } from '../../../../packages/web-auth/src/auth-panel';

@Component({
  selector: 'af-auth-root',
  imports: [App, AuthPanel],
  template: `
    @if (auth.ready()) {
      @if (auth.config()?.mode === 'google') {
        <div class="session-bar">
          {{ auth.actor()?.role }} · <button (click)="auth.signOut()">Sign out</button>
        </div>
      } @else {
        <div class="session-bar">Local demo mode · identity is not verified</div>
      }
      <app-root />
    } @else {
      <af-auth-panel />
    }
  `,
  styles: [
    `
      .session-bar {
        padding: 8px 20px;
        background: #edf1fa;
        font: 13px system-ui;
        text-align: right;
      }
    `,
  ],
})
export class AuthRoot implements OnInit {
  readonly auth = inject(AuthSession);
  ngOnInit(): void {
    void this.auth.initialize('ADMIN');
  }
}
