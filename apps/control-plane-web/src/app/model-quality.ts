import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  ModelQualityOverview,
  QualityRunPoint,
  QualitySeries,
  QualitySeriesStatus,
} from '@agents-foundry/contracts';
import { AuthSession, API_URL } from '../../../../packages/web-auth/src/session';

const STATUS_ORDER: Record<QualitySeriesStatus, number> = {
  REGRESSED: 0,
  NEW: 1,
  IMPROVED: 2,
  STEADY: 3,
};
const BARS = '▁▂▃▄▅▆▇█';

/**
 * Model quality (ADR 0026): how each model scores on each role's quality tasks in the weekly
 * live evaluation (ADR 0025), so admins can choose models from evidence.
 */
@Component({
  selector: 'af-model-quality',
  imports: [FormsModule, DatePipe],
  template: `@if (auth.config()?.mode === 'password') {
    <section aria-labelledby="quality-heading">
      <h2 id="quality-heading">Model quality</h2>
      <p>
        Scores from the weekly live evaluation: a real model works each role's quality tasks and a
        grader model scores the result. Each row is one model on one task. The latest run is
        compared with the three before it. Scores compare fairly only with the same grader and role
        version.
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (overview(); as data) {
        @if (!data.series.length) {
          <p>
            No results yet. An operator imports the scheduled run's
            <code>quality-history</code> artifact with
            <code>npm run db:import-quality -- &lt;absolute path&gt;</code>.
          </p>
        } @else {
          <p class="meta">
            Since {{ data.since | date: 'mediumDate' }} · last imported
            {{ data.lastImportedAt | date: 'medium' }}
          </p>
          <label
            >Role<select name="role" [(ngModel)]="role">
              <option value="">All roles</option>
              @for (option of roles(); track option) {
                <option [value]="option">{{ option }}</option>
              }
            </select></label
          >
          @for (group of groups(); track group.key) {
            <h3>{{ group.blueprint }} · {{ group.task }}</h3>
            <table>
              <thead>
                <tr>
                  <th scope="col">Model (grader)</th>
                  <th scope="col">Status</th>
                  <th scope="col">Latest</th>
                  <th scope="col">Before</th>
                  <th scope="col">Scores</th>
                </tr>
              </thead>
              <tbody>
                @for (series of group.series; track series.model + series.judgeModel) {
                  <tr>
                    <td>
                      {{ series.provider }}/{{ series.model }}
                      <small>({{ series.judgeModel }})</small>
                    </td>
                    <td>
                      <span class="status" [attr.data-status]="series.status">{{
                        label(series.status)
                      }}</span>
                      @if (series.reasons.length) {
                        <small>{{ series.reasons.join('; ') }}</small>
                      }
                    </td>
                    <td>
                      {{ percent(series.latest.passRate) }} of {{ series.latest.trials }} passed ·
                      {{ series.latest.meanScore.toFixed(2) }}
                      <small>{{ series.latest.runAt | date: 'mediumDate' }}</small>
                    </td>
                    <td>
                      @if (series.baseline; as before) {
                        {{ percent(before.passRate) }} · {{ before.meanScore.toFixed(2) }}
                        <small>{{ before.runs }} {{ before.runs === 1 ? 'run' : 'runs' }}</small>
                      } @else {
                        –
                      }
                    </td>
                    <td>
                      <span class="spark" [attr.aria-label]="scoresLabel(series.runs)">{{
                        sparkline(series.runs)
                      }}</span>
                      <small
                        >{{ series.runs.length }}
                        {{ series.runs.length === 1 ? 'run' : 'runs' }}</small
                      >
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        }
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
        overflow-x: auto;
      }
      h2 {
        margin-top: 0;
      }
      p,
      label {
        font-size: 13px;
        line-height: 1.6;
      }
      label {
        display: grid;
        gap: 8px;
        max-width: 360px;
      }
      select {
        padding: 9px;
        border: 1px solid #cbd7e6;
        border-radius: 8px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th,
      td {
        text-align: left;
        vertical-align: top;
        padding: 8px 10px 8px 0;
        border-bottom: 1px solid #e0e7f0;
      }
      td small {
        display: block;
      }
      .status {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        background: #eef2f7;
      }
      .status[data-status='REGRESSED'] {
        background: #fde8e8;
        color: #9b1c1c;
      }
      .status[data-status='IMPROVED'] {
        background: #e6f6ec;
        color: #1c6b3a;
      }
      .spark {
        font-size: 16px;
        letter-spacing: 1px;
      }
      small,
      .meta {
        color: #60728b;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class ModelQuality implements OnInit {
  readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly overview = signal<ModelQualityOverview | null>(null);
  readonly error = signal('');
  private readonly selected = signal('');

  get role() {
    return this.selected();
  }
  set role(value: string) {
    this.selected.set(value);
  }

  readonly roles = computed(() =>
    [...new Set((this.overview()?.series ?? []).map((series) => series.blueprint))].sort(),
  );

  /** One table per role version and task; regressions first within each. */
  readonly groups = computed(() => {
    const groups = new Map<
      string,
      { key: string; blueprint: string; task: string; series: QualitySeries[] }
    >();
    for (const series of this.overview()?.series ?? []) {
      if (this.selected() && series.blueprint !== this.selected()) continue;
      const key = `${series.blueprint} ${series.task}`;
      const group = groups.get(key) ?? {
        key,
        blueprint: series.blueprint,
        task: series.task,
        series: [],
      };
      group.series.push(series);
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((group) => ({
        ...group,
        series: [...group.series].sort(
          (a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            b.latest.meanScore - a.latest.meanScore,
        ),
      }));
  });

  ngOnInit() {
    if (this.auth.config()?.mode === 'password') void this.refresh();
  }

  async refresh() {
    this.error.set('');
    try {
      this.overview.set(
        await firstValueFrom(this.http.get<ModelQualityOverview>(`${API_URL}/catalog/v1/quality`)),
      );
    } catch {
      this.error.set('Could not load model quality. Refresh and try again.');
    }
  }

  label(status: QualitySeriesStatus) {
    return { REGRESSED: 'Regressed', NEW: 'New', IMPROVED: 'Improved', STEADY: 'Steady' }[status];
  }

  percent(value: number) {
    return `${Math.round(value * 100)}%`;
  }

  /** The last eight mean scores, oldest first, as bars from 0 to 1. */
  sparkline(runs: readonly QualityRunPoint[]) {
    return runs
      .slice(-8)
      .map((run) => BARS[Math.min(BARS.length - 1, Math.floor(run.meanScore * BARS.length))])
      .join('');
  }

  scoresLabel(runs: readonly QualityRunPoint[]) {
    return `Mean scores, oldest first: ${runs
      .slice(-8)
      .map((run) => run.meanScore.toFixed(2))
      .join(', ')}`;
  }
}
