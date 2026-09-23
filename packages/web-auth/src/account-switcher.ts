import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthSession } from './session';

@Component({
  selector: 'af-account-switcher',
  imports: [FormsModule],
  template: `
    @if (auth.config()?.mode === 'password' && auth.memberships().length > 1) {
      <label class="account-switcher">
        Organization
        <select
          [ngModel]="auth.actor()?.organizationId"
          (ngModelChange)="switchTo($event)"
          [disabled]="auth.signingIn()"
        >
          @for (membership of auth.memberships(); track membership.organizationId) {
            <option [value]="membership.organizationId">
              {{ membership.organizationName }} · {{ membership.role }}
            </option>
          }
        </select>
      </label>
    }
  `,
  styles: [
    `
      .account-switcher {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        font: 13px system-ui;
      }
      select {
        max-width: 18rem;
        padding: 0.25rem;
      }
    `,
  ],
})
export class AccountSwitcher {
  readonly auth = inject(AuthSession);
  switchTo(organizationId: string): void {
    void this.auth.switchOrganization(organizationId);
  }
}
