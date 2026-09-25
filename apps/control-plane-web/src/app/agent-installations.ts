import { Component, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  CatalogBlueprintSummary,
  CatalogQuestion,
  OrganizationAgentInstallation,
  ResolvedBlueprintBundle,
} from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

@Component({
  selector: 'af-agent-installations',
  imports: [FormsModule],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="installations-heading">
      <h2 id="installations-heading">Agent catalog and installations</h2>
      <p>
        Install a versioned role blueprint once for your organization, with its shared settings.
        Agents created from an installation inherit those settings. Changes apply only to agents
        created afterwards; issued agent configurations are never modified.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      <button type="button" (click)="refresh()" [disabled]="busy() || loading()">
        Refresh catalog and installations
      </button>
      <form #installForm="ngForm" (ngSubmit)="installForm.valid && install()">
        <h3>Install a blueprint</h3>
        <label
          >Blueprint version<select
            name="blueprint"
            [(ngModel)]="selectedKey"
            (ngModelChange)="selectBlueprint($event)"
            required
            [disabled]="busy()"
          >
            <option value="" disabled>Select a blueprint</option>
            @for (summary of catalog(); track summary.id + summary.version) {
              <option [value]="summary.id + '@' + summary.version">
                {{ summary.title }} {{ summary.version }}{{ summary.latest ? ' (latest)' : '' }}
              </option>
            }
          </select></label
        >
        @if (bundle(); as selected) {
          <p>{{ selected.blueprint.mission }}</p>
          <p>Skills: {{ skillTitles(selected) }} · Workflows: {{ workflowTitles(selected) }}</p>
          <label
            >Installation name<input
              name="installationName"
              [(ngModel)]="name"
              required
              maxlength="120"
              [disabled]="busy()"
          /></label>
          @for (question of installationQuestions(selected); track question.id) {
            @if (question.type === 'multiselect') {
              <fieldset [disabled]="busy()">
                <legend>{{ question.label }}</legend>
                @for (option of question.options ?? []; track option) {
                  <label class="choice"
                    ><input
                      type="checkbox"
                      [checked]="(configuration[question.id] ?? []).includes(option)"
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
                  [(ngModel)]="configuration[question.id]"
                  [required]="question.required"
                  [disabled]="busy()"
              /></label>
            }
          }
          <button type="submit" [disabled]="busy() || !installForm.valid">
            {{ busy() ? 'Installing…' : 'Install' }}
          </button>
        }
      </form>
      <h3>Installations</h3>
      @for (installation of installations(); track installation.id) {
        <article>
          <strong>{{ installation.name }}</strong>
          <span>{{ installation.blueprintId }} {{ installation.blueprintVersion }}</span>
          <small>{{ installation.status }}</small>
          @if (installation.status === 'ACTIVE') {
            <button type="button" (click)="retire(installation)" [disabled]="busy()">Retire</button>
          }
        </article>
      } @empty {
        <p>No installations yet.</p>
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
        align-items: center;
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
export class AgentInstallations implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly changed = output<void>();
  readonly catalog = signal<CatalogBlueprintSummary[]>([]);
  readonly installations = signal<OrganizationAgentInstallation[]>([]);
  readonly bundle = signal<ResolvedBlueprintBundle | null>(null);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  selectedKey = '';
  name = '';
  configuration: Record<string, string | string[]> = {};

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  installationQuestions(bundle: ResolvedBlueprintBundle): CatalogQuestion[] {
    return bundle.blueprint.questionnaire.filter((question) => question.scope === 'INSTALLATION');
  }

  skillTitles(bundle: ResolvedBlueprintBundle): string {
    return bundle.skills.map((skill) => skill.title).join(', ');
  }

  workflowTitles(bundle: ResolvedBlueprintBundle): string {
    return bundle.workflows.map((workflow) => workflow.title).join(', ');
  }

  toggle(id: string, option: string, checked: boolean) {
    const current = Array.isArray(this.configuration[id])
      ? (this.configuration[id] as string[])
      : [];
    this.configuration[id] = checked
      ? [...new Set([...current, option])]
      : current.filter((value) => value !== option);
  }

  async refresh() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [catalog, installations] = await Promise.all([
        firstValueFrom(
          this.http.get<CatalogBlueprintSummary[]>(`${API_URL}/catalog/v1/blueprints`),
        ),
        firstValueFrom(
          this.http.get<OrganizationAgentInstallation[]>(
            `${API_URL}/organization/agent-installations`,
            { params: { status: 'all' } },
          ),
        ),
      ]);
      this.catalog.set(catalog);
      this.installations.set(installations);
    } catch {
      this.error.set('Could not load the agent catalog. Refresh and try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async selectBlueprint(key: string) {
    const separator = key.lastIndexOf('@');
    if (separator < 1) return;
    this.bundle.set(null);
    this.configuration = {};
    try {
      this.bundle.set(
        await firstValueFrom(
          this.http.get<ResolvedBlueprintBundle>(
            `${API_URL}/catalog/v1/blueprints/${encodeURIComponent(key.slice(0, separator))}/versions/${encodeURIComponent(key.slice(separator + 1))}`,
          ),
        ),
      );
    } catch {
      this.error.set('That blueprint version could not be loaded.');
    }
  }

  async install() {
    const bundle = this.bundle();
    if (this.busy() || !bundle) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await firstValueFrom(
        this.http.post<OrganizationAgentInstallation>(
          `${API_URL}/organization/agent-installations`,
          {
            name: this.name.trim(),
            blueprintId: bundle.blueprint.id,
            blueprintVersion: bundle.blueprint.version,
            configuration: structuredClone(this.configuration),
          },
        ),
      );
      this.notice.set(`${this.name.trim()} installed. Create agents from it below.`);
      this.name = '';
      this.configuration = {};
      this.changed.emit();
      await this.refresh();
    } catch {
      this.error.set(
        'Installation failed. Answer every setting, and use a name that is not already in use.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  async retire(installation: OrganizationAgentInstallation) {
    if (
      this.busy() ||
      !confirm(
        `Retire ${installation.name}? No new agents can be created from it; existing agents keep working.`,
      )
    )
      return;
    this.busy.set(true);
    this.error.set('');
    try {
      await firstValueFrom(
        this.http.post(`${API_URL}/organization/agent-installations/${installation.id}/retire`, {
          version: installation.version,
        }),
      );
      this.notice.set(`${installation.name} retired.`);
      this.changed.emit();
      await this.refresh();
    } catch {
      this.error.set('Retirement failed. Someone may have changed it; refresh and try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
