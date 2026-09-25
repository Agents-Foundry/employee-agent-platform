import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  ConnectorConnection,
  GovernedActionSummary,
  OrganizationPolicyOutcome,
} from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

/**
 * Action Gateway administration (ADR 0012): connections to external systems, holding secret
 * references only, and tighten-only overrides of governed-action policy.
 */
@Component({
  selector: 'af-action-governance',
  imports: [FormsModule],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="governance-heading">
      <h2 id="governance-heading">Governed actions and connections</h2>
      <p>
        Agents never hold credentials or call external systems directly. The platform decides each
        governed action, asks for approval where policy requires it, and performs approved writes
        through these connections.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      <button type="button" (click)="refresh()" [disabled]="busy() || loading()">
        Refresh governance
      </button>

      <h3>Connections</h3>
      @for (connection of connections(); track connection.id) {
        <article>
          <div>
            <strong>{{ connection.name }}</strong>
            <small>{{ connection.provider }} · {{ connection.baseUrl }}</small>
            <small
              >Credential {{ connection.secretRef }} · Projects
              {{ connection.settings.allowedProjects.join(', ') || 'none' }}</small
            >
          </div>
          <small>{{ connection.status }}</small>
          @if (connection.status === 'ACTIVE') {
            <button type="button" (click)="disable(connection)" [disabled]="busy()">Disable</button>
          }
        </article>
      } @empty {
        <p>No connections yet. Issue-tracker writes are denied until one is configured.</p>
      }
      <form #connectionForm="ngForm" (ngSubmit)="connectionForm.valid && connect()">
        <h4>Connect Jira</h4>
        <label
          >Name<input name="name" [(ngModel)]="name" required maxlength="120" [disabled]="busy()"
        /></label>
        <label
          >Site URL<input
            name="baseUrl"
            type="url"
            [(ngModel)]="baseUrl"
            required
            placeholder="https://your-site.atlassian.net"
            [disabled]="busy()"
        /></label>
        <label
          >Credential reference<input
            name="secretRef"
            [(ngModel)]="secretRef"
            required
            pattern="secret://[a-z0-9][a-z0-9._-]{0,63}"
            placeholder="secret://jira-api-token"
            [disabled]="busy()"
          /><small
            >A reference to a token in the platform secret store. Never paste the token here.</small
          ></label
        >
        <label
          >Account email<input
            name="authEmail"
            type="email"
            [(ngModel)]="authEmail"
            [disabled]="busy()"
        /></label>
        <label
          >Allowed project keys<input
            name="projects"
            [(ngModel)]="projects"
            placeholder="QA, WEB"
            [disabled]="busy()"
        /></label>
        <button type="submit" [disabled]="busy() || !connectionForm.valid">
          {{ busy() ? 'Saving…' : 'Add connection' }}
        </button>
      </form>

      <h3>Action policy</h3>
      <p>Organization rules can require approval or deny an action. They can never allow more.</p>
      @for (item of actions(); track item.action) {
        <article>
          <div>
            <strong>{{ item.action }}</strong>
            <small
              >Platform default {{ item.defaultOutcome }} · {{ item.risk }} risk ·
              {{
                item.executedBy === 'CONTROL_PLANE'
                  ? 'performed by the platform'
                  : 'performed by the agent runtime'
              }}</small
            >
            @if (item.override) {
              <small
                >Organization rule: {{ item.override.outcome }} — {{ item.override.reason }}</small
              >
            }
          </div>
          @if (item.defaultOutcome !== 'DENY') {
            <div class="controls">
              @if (item.override) {
                <button type="button" (click)="clear(item)" [disabled]="busy()">
                  Use platform default
                </button>
              }
              @if (
                item.defaultOutcome === 'ALLOW' && item.override?.outcome !== 'REQUIRE_APPROVAL'
              ) {
                <button
                  type="button"
                  (click)="tighten(item, 'REQUIRE_APPROVAL')"
                  [disabled]="busy()"
                >
                  Require approval
                </button>
              }
              @if (item.override?.outcome !== 'DENY') {
                <button type="button" (click)="tighten(item, 'DENY')" [disabled]="busy()">
                  Deny
                </button>
              }
            </div>
          }
        </article>
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
      p {
        font-size: 13px;
        line-height: 1.6;
      }
      form {
        display: grid;
        gap: 14px;
        margin: 20px 0;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
      }
      input {
        box-sizing: border-box;
        min-width: 0;
        width: 100%;
        padding: 11px;
        border: 1px solid #cbd7e6;
        border-radius: 8px;
      }
      button {
        padding: 10px 14px;
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
        align-items: center;
        justify-content: space-between;
        padding: 14px 0;
        border-bottom: 1px solid #e0e7f0;
      }
      article div {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .controls {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      small {
        color: #60728b;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class ActionGovernance implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly connections = signal<ConnectorConnection[]>([]);
  readonly actions = signal<GovernedActionSummary[]>([]);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  name = '';
  baseUrl = '';
  secretRef = '';
  authEmail = '';
  projects = '';

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  async refresh() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [connections, actions] = await Promise.all([
        firstValueFrom(
          this.http.get<ConnectorConnection[]>(`${API_URL}/organization/connector-connections`),
        ),
        firstValueFrom(
          this.http.get<GovernedActionSummary[]>(`${API_URL}/organization/action-policies`),
        ),
      ]);
      this.connections.set(connections);
      this.actions.set(actions);
    } catch {
      this.error.set('Could not load governance settings. Refresh and try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async connect() {
    if (this.busy()) return;
    const allowedProjects = [
      ...new Set(
        this.projects
          .split(',')
          .map((key) => key.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    await this.mutate(
      () =>
        this.http.post(`${API_URL}/organization/connector-connections`, {
          provider: 'jira',
          name: this.name.trim(),
          baseUrl: this.baseUrl.trim(),
          secretRef: this.secretRef.trim(),
          settings: {
            ...(this.authEmail.trim() ? { authEmail: this.authEmail.trim() } : {}),
            allowedProjects,
          },
        }),
      `${this.name.trim()} connected.`,
      'The connection was rejected. Use an HTTPS site address, a secret:// reference and valid project keys; only one Jira connection can be active.',
    );
    if (!this.error()) {
      this.name = '';
      this.baseUrl = '';
      this.secretRef = '';
      this.authEmail = '';
      this.projects = '';
    }
  }

  async disable(connection: ConnectorConnection) {
    if (this.busy() || !confirm(`Disable ${connection.name}? Governed writes through it stop.`))
      return;
    await this.mutate(
      () =>
        this.http.post(`${API_URL}/organization/connector-connections/${connection.id}/disable`, {
          version: connection.version,
        }),
      `${connection.name} disabled.`,
      'Could not disable the connection. Someone may have changed it; refresh and try again.',
    );
  }

  async tighten(item: GovernedActionSummary, outcome: OrganizationPolicyOutcome) {
    if (this.busy()) return;
    const reason = prompt(
      `Why should ${item.action} ${outcome === 'DENY' ? 'be denied' : 'require approval'}?`,
    );
    if (!reason?.trim()) return;
    await this.mutate(
      () =>
        this.http.put(
          `${API_URL}/organization/action-policies/${encodeURIComponent(item.action)}`,
          {
            outcome,
            reason: reason.trim(),
          },
        ),
      `${item.action} now ${outcome === 'DENY' ? 'denied' : 'requires approval'}.`,
      'The rule could not be saved.',
    );
  }

  async clear(item: GovernedActionSummary) {
    if (this.busy()) return;
    await this.mutate(
      () =>
        this.http.delete(
          `${API_URL}/organization/action-policies/${encodeURIComponent(item.action)}`,
        ),
      `${item.action} uses the platform default again.`,
      'The rule could not be removed.',
    );
  }

  private async mutate(
    request: () => ReturnType<HttpClient['post']>,
    success: string,
    failure: string,
  ) {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await firstValueFrom(request());
      this.notice.set(success);
      await this.refresh();
    } catch {
      this.error.set(failure);
    } finally {
      this.busy.set(false);
    }
  }
}
