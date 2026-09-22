import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

interface Member {
  id: string;
  displayName: string;
  email: string;
  role: string;
  team: string;
  status: string;
}
@Component({
  selector: 'af-organization-admin',
  imports: [FormsModule],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="organization-heading">
      <h2 id="organization-heading">Organization members</h2>
      <p>
        Invite employees to your workspace. They choose their own password using a one-time
        activation link.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      <form #inviteForm="ngForm" (ngSubmit)="inviteForm.valid && invite()">
        <label>Name<input name="name" [(ngModel)]="name" required maxlength="200" /></label>
        <label
          >Work email<input
            name="email"
            [(ngModel)]="email"
            required
            email
            type="email"
            maxlength="254"
        /></label>
        <label>Team<input name="team" [(ngModel)]="team" required maxlength="120" /></label>
        <button [disabled]="busy() || !inviteForm.valid">Invite employee</button>
      </form>
      @if (link()) {
        <div class="invitation" role="status">
          <strong>Invitation created · expires in 48 hours</strong>
          <p>
            Email delivery is not connected yet. Share this private, single-use link with the
            invited employee through your approved secure channel.
          </p>
          <label>Activation link<input readonly [value]="link()" /></label>
          <button type="button" (click)="link.set('')">Dismiss private link</button>
        </div>
      }
      <div class="members">
        @for (member of members(); track member.id) {
          <article>
            <div>
              <strong>{{ member.displayName }}</strong>
              <p>{{ member.email }} · {{ member.team }}</p>
              <small>{{ member.role }} · {{ member.status }}</small>
            </div>
            @if (member.role === 'EMPLOYEE' && member.status !== 'INACTIVE') {
              @if (confirmDisable() === member.id) {
                <span>Revoke access immediately?</span
                ><button type="button" [disabled]="busy()" (click)="disable(member)">
                  Confirm disable</button
                ><button type="button" (click)="confirmDisable.set('')">Cancel</button>
              } @else {
                <button type="button" (click)="confirmDisable.set(member.id)">Disable</button>
              }
            }
          </article>
        }
      </div>
    </section>
  }`,
  styles: [
    `
      section {
        background: white;
        border: 1px solid #dde4ee;
        border-radius: 16px;
        padding: 24px;
        margin: 24px 0;
        color: #223451;
      }
      h2 {
        margin-top: 0;
      }
      p {
        font-size: 13px;
        line-height: 1.6;
      }
      form {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: end;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 12px;
        flex: 1;
      }
      input {
        padding: 12px;
        border: 1px solid #ccd7e5;
        border-radius: 8px;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
      }
      button {
        padding: 12px;
        border: 1px solid #bccce0;
        border-radius: 8px;
        background: #edf3fc;
        color: #234267;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .invitation {
        background: #edf5ff;
        padding: 16px;
        margin-top: 20px;
      }
      .invitation button {
        margin-top: 12px;
      }
      article {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 16px 0;
        border-bottom: 1px solid #e3e9f1;
      }
      article > div {
        flex: 1;
      }
      article p {
        margin: 5px 0;
      }
    `,
  ],
})
export class OrganizationAdmin implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly members = signal<Member[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly link = signal('');
  readonly confirmDisable = signal('');
  name = '';
  email = '';
  team = '';
  ngOnInit() {
    if (this.auth.config()?.mode === 'password') this.refresh();
  }
  refresh() {
    this.http
      .get<Member[]>(`${API_URL}/organization/members`)
      .subscribe({
        next: (rows) => this.members.set(rows),
        error: () => this.error.set('Could not load organization members.'),
      });
  }
  invite() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.link.set('');
    this.http
      .post<{ activationUrl: string }>(`${API_URL}/organization/invitations`, {
        displayName: this.name,
        email: this.email,
        team: this.team,
      })
      .subscribe({
        next: (result) => {
          this.link.set(result.activationUrl);
          this.name = this.email = this.team = '';
          this.busy.set(false);
          this.refresh();
        },
        error: () => {
          this.error.set(
            'Invitation failed. Check the details; the email may already be assigned.',
          );
          this.busy.set(false);
        },
      });
  }
  disable(member: Member) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post(`${API_URL}/organization/members/${member.id}/disable`, {}).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmDisable.set('');
        this.link.set('');
        this.refresh();
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Unable to disable this member.');
      },
    });
  }
}
