import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { API_URL, AuthSession } from '../../../../../packages/web-auth/src/session';
import type {
  SetupProgress as Progress,
  SetupStepId,
} from '../../../../../packages/contracts/src/tenancy';

const details: Record<SetupStepId, { label: string; description: string; href: string }> = {
  profile: {
    label: 'Complete your profile',
    description: 'Add the legal name and country.',
    href: '#organization-profile',
  },
  structure: {
    label: 'Create a unit',
    description: 'Add a department, team, or other unit.',
    href: '#organization-structure',
  },
  positions: {
    label: 'Define a position',
    description: 'Connect a unit, job role, and level.',
    href: '#job-architecture',
  },
  people: {
    label: 'Add an employee',
    description: 'Record someone beyond the initial administrator.',
    href: '#people-directory',
  },
  assignments: {
    label: 'Assign a position',
    description: 'Give an active employee an active position.',
    href: '#people-directory',
  },
  employee_access: {
    label: 'Activate employee access',
    description: 'Have an invited employee activate their account.',
    href: '#people-directory',
  },
  domain: {
    label: 'Verify a domain',
    description: 'Optional for custom-domain routing.',
    href: '#organization-profile',
  },
};

@Component({
  selector: 'af-setup-progress',
  template: `
    @if (auth.config()?.mode === 'password') {
      <section id="setup-progress" aria-labelledby="setup-title">
        <header>
          <div>
            <p>GETTING STARTED</p>
            <h2 id="setup-title">Organization setup</h2>
          </div>
          <button type="button" (click)="load()" [disabled]="loading()">Refresh progress</button>
        </header>
        <p>
          This checklist reflects current organization records. It is not an agent-readiness or
          activation approval.
        </p>
        @if (loading()) {
          <p role="status">Checking setup…</p>
        }
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        @if (progress(); as result) {
          <p role="status">
            {{ result.completedRequired }} of {{ result.totalRequired }} required steps complete
          </p>
          <ul>
            @for (step of result.steps; track step.id) {
              <li>
                <span aria-hidden="true">{{ step.complete ? '✓' : '○' }}</span>
                <div>
                  <strong>{{ details[step.id].label }}</strong>
                  <small
                    >{{ details[step.id].description }}
                    {{ step.required ? '' : 'Optional.' }}</small
                  >
                </div>
                <a [href]="details[step.id].href">{{ step.complete ? 'Review' : 'Set up' }}</a>
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      section {
        background: white;
        border: 1px solid #e3e8f2;
        border-radius: 16px;
        padding: 24px;
        margin-bottom: 24px;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }
      header p {
        color: #6f5cf1;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        margin: 0;
      }
      h2 {
        margin: 5px 0 0;
      }
      section > p {
        color: #52607c;
      }
      button {
        border: 1px solid #d9dfec;
        border-radius: 8px;
        background: white;
        padding: 8px 12px;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
      }
      ul {
        padding: 0;
        margin: 16px 0 0;
        list-style: none;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 12px;
      }
      li {
        border: 1px solid #e3e8f2;
        border-radius: 10px;
        padding: 14px;
        display: flex;
        align-items: start;
        gap: 10px;
      }
      li span {
        color: #6f5cf1;
        font-weight: 800;
      }
      li div {
        flex: 1;
      }
      small {
        display: block;
        color: #62708d;
        margin-top: 4px;
        line-height: 1.4;
      }
      a {
        color: #5142bf;
        font-weight: 700;
        white-space: nowrap;
      }
    `,
  ],
})
export class SetupProgress implements OnInit {
  protected readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  protected readonly details = details;
  readonly progress = signal<Progress | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  ngOnInit(): void {
    if (this.auth.config()?.mode === 'password') this.load();
  }
  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    this.http.get<Progress>(`${API_URL}/organization/setup-progress`).subscribe({
      next: (result) => {
        this.progress.set(result);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load setup progress. Try again.');
      },
    });
  }
}
