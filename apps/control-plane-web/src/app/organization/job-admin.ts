import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { API_URL, AuthSession } from '../../../../../packages/web-auth/src/session';
import { jobKinds, type JobKind, type JobRecord } from '../../../../../packages/contracts/src/jobs';
import type { Page } from '../../../../../packages/contracts/src/organization';
import { RecordPicker } from './record-picker';

interface ReferenceField {
  key: string;
  label: string;
  path: string;
  optional?: boolean;
}
const family: ReferenceField = { key: 'jobFamilyId', label: 'Job family', path: 'jobs/families' };
const fields: Record<JobKind, ReferenceField[]> = {
  families: [],
  disciplines: [family],
  roles: [family, { key: 'disciplineId', label: 'Discipline', path: 'jobs/disciplines' }],
  levels: [],
  positions: [
    { key: 'organizationalUnitId', label: 'Department or team', path: 'units' },
    { key: 'roleId', label: 'Job role', path: 'jobs/roles' },
    { key: 'jobLevelId', label: 'Job level', path: 'jobs/levels' },
    {
      key: 'reportsToPositionId',
      label: 'Reports to position',
      path: 'jobs/positions',
      optional: true,
    },
  ],
};
@Component({
  selector: 'af-job-admin',
  imports: [FormsModule, ReactiveFormsModule, RecordPicker],
  templateUrl: './job-admin.html',
  styleUrl: './structure-admin.css',
})
export class JobAdmin implements OnInit {
  protected readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  private listRevision = 0;
  readonly base = `${API_URL}/organization`;
  readonly kinds = jobKinds;
  readonly labels: Record<JobKind, string> = {
    families: 'Job families',
    disciplines: 'Disciplines',
    roles: 'Job roles',
    levels: 'Job levels',
    positions: 'Positions',
  };
  readonly rows = signal<Page<JobRecord>>({ items: [], total: 0, page: 1, pageSize: 25 });
  readonly selected = signal<JobRecord | null>(null);
  readonly confirmation = signal<JobRecord | null>(null);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  kind: JobKind = 'families';
  search = '';
  status = 'active';
  sort = 'name';
  references: Record<string, string | null> = {};
  referenceNames: Record<string, string> = {};
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(160)],
    }),
    code: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)],
    }),
    description: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(2000)],
    }),
    rank: new FormControl(0, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(0),
        Validators.max(10000),
        Validators.pattern(/^\d+$/),
      ],
    }),
  });
  ngOnInit(): void {
    if (this.auth.config()?.mode === 'password') this.load();
  }
  referenceFields(): ReferenceField[] {
    return fields[this.kind];
  }
  valid(): boolean {
    return (
      this.form.valid &&
      this.referenceFields().every((field) => field.optional || this.references[field.key])
    );
  }
  changeKind(): void {
    this.create();
    this.search = '';
    this.status = 'active';
    this.load();
  }
  create(): void {
    if (this.busy()) return;
    this.notice.set('');
    this.selected.set(null);
    this.confirmation.set(null);
    this.references = {};
    this.referenceNames = {};
    this.form.reset({ name: '', code: '', description: '', rank: 0 });
  }
  edit(record: JobRecord): void {
    if (this.busy()) return;
    this.selected.set(record);
    this.confirmation.set(null);
    this.error.set('');
    this.notice.set('');
    this.form.setValue({
      name: record.name,
      code: record.code,
      description: record.description,
      rank: record.rank ?? 0,
    });
    this.references = {};
    this.referenceNames = {};
    for (const field of this.referenceFields()) {
      this.references[field.key] = (record[field.key as keyof JobRecord] as string | null) ?? null;
      this.referenceNames[field.key] = this.references[field.key]
        ? (record.referenceNames?.[field.key] ?? 'Current selection (search to change)')
        : 'Not assigned';
    }
  }
  choose(field: ReferenceField, record: { id: string; name: string } | null): void {
    this.references[field.key] = record?.id ?? null;
    this.referenceNames[field.key] = record?.name ?? 'Not assigned';
  }
  load(page = 1): void {
    const revision = ++this.listRevision;
    this.loading.set(true);
    this.error.set('');
    const kind = this.kind;
    this.http
      .get<Page<JobRecord>>(`${this.base}/jobs/${kind}`, {
        params: { page, pageSize: 25, search: this.search, status: this.status, sort: this.sort },
      })
      .subscribe({
        next: (result) => {
          if (this.kind === kind && revision === this.listRevision) {
            this.rows.set(result);
            this.loading.set(false);
          }
        },
        error: (e) => {
          if (this.kind === kind && revision === this.listRevision) {
            this.loading.set(false);
            this.fail(e);
          }
        },
      });
  }
  save(): void {
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    const value = this.form.getRawValue();
    const body: Record<string, string | number | null> = {
      name: value.name,
      code: value.code,
      description: value.description,
    };
    for (const field of this.referenceFields())
      body[field.key] = this.references[field.key] ?? null;
    if (this.kind === 'levels') body['rank'] = value.rank;
    const selected = this.selected();
    const operation = selected
      ? this.http.put<JobRecord>(`${this.base}/jobs/${this.kind}/${selected.id}`, {
          ...body,
          version: selected.version,
        })
      : this.http.post<JobRecord>(`${this.base}/jobs/${this.kind}`, body);
    operation.subscribe({
      next: (record) => {
        this.busy.set(false);
        this.edit(record);
        this.notice.set('Job record saved.');
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e);
      },
    });
  }
  archive(): void {
    const record = this.confirmation();
    if (!record || this.busy()) return;
    this.busy.set(true);
    this.http
      .post(`${this.base}/jobs/${this.kind}/${record.id}/archive`, { version: record.version })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.create();
          this.notice.set('Archived. Historical references are retained.');
          this.load();
        },
        error: (e) => {
          this.busy.set(false);
          this.fail(e);
        },
      });
  }
  private fail(error: HttpErrorResponse): void {
    const code = error.error?.error;
    this.error.set(
      code === 'JOB_VERSION_CONFLICT'
        ? 'This record changed. Refresh and reopen it before saving.'
        : code === 'JOB_DEPENDENCY_CONFLICT'
          ? 'The code is already used, the family and discipline do not match, the reporting line forms a cycle, or active records still depend on this item.'
          : code === 'JOB_DEPENDENCY_NOT_FOUND'
            ? 'A selected dependency is missing, archived, or outside your organization. Choose an active record.'
            : 'The request failed. Check the fields and refresh before retrying.',
    );
  }
}
