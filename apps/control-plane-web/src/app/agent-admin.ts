import { Component, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminAgentInput,
  AgentAssignment,
  AgentBlueprint,
  KeySource,
} from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

interface Recipient {
  id: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
}
@Component({
  selector: 'af-agent-admin',
  imports: [FormsModule, DatePipe],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="agent-setup-heading">
      <h2 id="agent-setup-heading">Create and assign agents</h2>
      <p>
        Configure a specialist agent and assign a separate, private instance to each selected
        employee.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      <button type="button" (click)="refresh()" [disabled]="busy() || loading()">
        Refresh employees and assignments
      </button>
      @if (blueprint(); as definition) {
        <form #agentForm="ngForm" (ngSubmit)="agentForm.valid && create()">
          <h3>{{ definition.title }} · {{ definition.version }}</h3>
          <p>{{ definition.mission }}</p>
          <label
            >Agent name<input
              name="agentName"
              [(ngModel)]="name"
              required
              maxlength="120"
              [disabled]="busy()"
          /></label>
          <fieldset [disabled]="busy()">
            <legend>Assign to active employees (up to 25)</legend>
            @for (employee of recipients(); track employee.id) {
              <label class="choice"
                ><input
                  type="checkbox"
                  [checked]="selected.includes(employee.id)"
                  (change)="select(employee.id, $any($event.target).checked)"
                />{{ employee.displayName }} · {{ employee.email }}</label
              >
            } @empty {
              <p>
                Invite employees and have them activate their accounts first, then refresh this
                list.
              </p>
            }
          </fieldset>
          @for (question of definition.questionnaire; track question.id) {
            @if (question.type === 'multiselect') {
              <fieldset [disabled]="busy()">
                <legend>{{ question.label }}</legend>
                @for (option of question.options ?? []; track option) {
                  <label class="choice"
                    ><input
                      type="checkbox"
                      [checked]="(answers[question.id] ?? []).includes(option)"
                      (change)="toggle(question.id, option, $any($event.target).checked)"
                    />{{ option }}</label
                  >
                }
              </fieldset>
            } @else {
              <label
                >{{ question.label
                }}<input
                  [name]="question.id"
                  [type]="question.type === 'url' ? 'url' : 'text'"
                  [(ngModel)]="answers[question.id]"
                  [required]="question.required"
                  [disabled]="busy()"
              /></label>
            }
          }
          <div class="columns">
            <label
              >Model provider<input
                name="provider"
                [(ngModel)]="provider"
                required
                maxlength="80"
                [disabled]="busy()"
            /></label>
            <label
              >Model identifier<input
                name="model"
                [(ngModel)]="model"
                required
                maxlength="160"
                [disabled]="busy()"
            /></label>
            <label
              >Credential preference<select
                name="credentialMode"
                [(ngModel)]="credentialMode"
                [disabled]="busy()"
              >
                <option value="ORGANIZATION_MANAGED">Organization managed</option>
                <option value="EMPLOYEE_BYOK">Employee BYOK</option>
              </select></label
            >
          </div>
          <p>
            Model preferences only. Credential storage and live model execution are not connected
            yet. Do not enter API keys.
          </p>
          <details>
            <summary>Review enforced permissions</summary>
            <ul>
              @for (capability of definition.capabilities; track capability.action) {
                <li>{{ capability.action }} — {{ capability.outcome }}</li>
              }
            </ul>
          </details>
          <p>
            Creation assigns signed configurations immediately. Browser execution and external
            writes still require the existing runtime approvals. Conversation history is not shared
            between employees.
          </p>
          <button
            type="submit"
            [disabled]="
              busy() ||
              loading() ||
              !agentForm.valid ||
              selected.length === 0 ||
              selected.length > 25
            "
          >
            {{ busy() ? 'Creating…' : 'Create and assign' }} ({{ selected.length }})
          </button>
        </form>
      }
      <h3>Admin-created assignments</h3>
      @for (assignment of assignments(); track assignment.agentId) {
        <article>
          <strong>{{ assignment.name }}</strong
          ><span>{{ assignment.employeeName }}</span
          ><small>{{ assignment.createdAt | date: 'medium' }}</small>
        </article>
      } @empty {
        <p>No admin-created agents yet.</p>
      }
    </section>
  }`,
  styles: [
    `
      section {
        background: white;
        border: 1px solid #dce4ef;
        border-radius: 16px;
        padding: 24px;
        margin: 24px 0;
        color: #243552;
      }
      h2 {
        margin-top: 0;
      }
      p,
      li {
        font-size: 13px;
        line-height: 1.6;
      }
      form {
        display: grid;
        gap: 16px;
        margin: 20px 0;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
      }
      input,
      select {
        box-sizing: border-box;
        min-width: 0;
        width: 100%;
        padding: 11px;
        border: 1px solid #cbd7e6;
        border-radius: 8px;
      }
      fieldset {
        border: 1px solid #dce4ef;
        border-radius: 10px;
        padding: 16px;
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      legend {
        font-size: 13px;
      }
      .choice {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .choice input {
        width: auto;
      }
      .columns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 16px;
      }
      button {
        padding: 12px 16px;
        border: 1px solid #bbcce0;
        border-radius: 8px;
        background: #edf4fd;
        color: #254c7c;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      article {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        justify-content: space-between;
        padding: 14px 0;
        border-bottom: 1px solid #e0e7f0;
      }
      small {
        color: #60728b;
      }
    `,
  ],
})
export class AgentAdmin implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly created = output<void>();
  readonly blueprint = signal<AgentBlueprint | null>(null);
  readonly recipients = signal<Recipient[]>([]);
  readonly assignments = signal<AgentAssignment[]>([]);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  name = '';
  provider = '';
  model = '';
  credentialMode: KeySource = 'ORGANIZATION_MANAGED';
  answers: Record<string, string | string[]> = {};
  selected: string[] = [];
  private pending: { fingerprint: string; requestId: string } | null = null;
  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }
  select(id: string, checked: boolean) {
    this.selected = checked
      ? [...new Set([...this.selected, id])]
      : this.selected.filter((value) => value !== id);
  }
  toggle(id: string, option: string, checked: boolean) {
    const current = Array.isArray(this.answers[id]) ? (this.answers[id] as string[]) : [];
    this.answers[id] = checked
      ? [...new Set([...current, option])]
      : current.filter((value) => value !== option);
  }
  async refresh() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [blueprints, recipients, assignments] = await Promise.all([
        firstValueFrom(this.http.get<AgentBlueprint[]>(`${API_URL}/blueprints`)),
        firstValueFrom(this.http.get<Recipient[]>(`${API_URL}/organization/members`)),
        firstValueFrom(this.http.get<AgentAssignment[]>(`${API_URL}/organization/agents`)),
      ]);
      this.blueprint.set(blueprints[0] ?? null);
      this.recipients.set(
        recipients.filter((member) => member.role === 'EMPLOYEE' && member.status === 'ACTIVE'),
      );
      this.assignments.set(assignments);
      this.selected = this.selected.filter((id) =>
        this.recipients().some((member) => member.id === id),
      );
    } catch {
      this.error.set('Could not load agent setup. Refresh and try again.');
    } finally {
      this.loading.set(false);
    }
  }
  async create() {
    const blueprint = this.blueprint();
    if (
      this.busy() ||
      this.loading() ||
      !blueprint ||
      !this.selected.length ||
      this.selected.length > 25
    )
      return;
    const body: Omit<AdminAgentInput, 'requestId'> = {
      name: this.name.trim(),
      employeeIds: [...this.selected].sort(),
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      provider: this.provider,
      model: this.model,
      credentialMode: this.credentialMode,
      answers: structuredClone(this.answers),
    };
    const fingerprint = JSON.stringify(body);
    if (this.pending?.fingerprint !== fingerprint)
      this.pending = { fingerprint, requestId: crypto.randomUUID() };
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const result = await firstValueFrom(
        this.http.post<AgentAssignment[]>(`${API_URL}/organization/agents`, {
          ...body,
          requestId: this.pending!.requestId,
        }),
      );
      this.pending = null;
      this.selected = [];
      this.notice.set(
        `${result.length} agent assignment(s) created. Employees can refresh their assigned agents.`,
      );
      this.created.emit();
      await this.refresh();
    } catch {
      this.error.set(
        'Creation failed. Check every blueprint field and active employee selection. Retrying unchanged settings is safe and will not create duplicates.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
