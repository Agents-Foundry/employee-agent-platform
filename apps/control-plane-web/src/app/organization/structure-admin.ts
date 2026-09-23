import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { FormsModule } from '@angular/forms';
import { API_URL, AuthSession } from '../../../../../packages/web-auth/src/session';
import {
  unitTypes,
  type OrganizationUnit,
  type Page,
  type UnitMembership,
} from '../../../../../packages/contracts/src/organization';
import { RecordPicker } from './record-picker';

@Component({
  selector: 'af-structure-admin',
  imports: [ReactiveFormsModule, FormsModule, RecordPicker],
  templateUrl: './structure-admin.html',
  styleUrl: './structure-admin.css',
})
export class StructureAdmin implements OnInit {
  protected readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  private listRevision = 0;
  private memberRevision = 0;
  readonly url = `${API_URL}/organization/units`;
  readonly types = unitTypes;
  readonly rows = signal<Page<OrganizationUnit>>({ items: [], total: 0, page: 1, pageSize: 25 });
  readonly path = signal<OrganizationUnit[]>([]);
  readonly selected = signal<OrganizationUnit | null>(null);
  readonly members = signal<Page<UnitMembership>>({ items: [], total: 0, page: 1, pageSize: 25 });
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly confirmation = signal<OrganizationUnit | null>(null);
  readonly memberRemoval = signal<UnitMembership | null>(null);
  view: 'tree' | 'table' = 'tree';
  search = '';
  status = 'active';
  type = '';
  sort = 'name';
  parentId: string | null = null;
  employeeId = '';
  employeeName = '';
  parentName = '';
  membershipType = 'member';
  isPrimary = false;
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(160)],
    }),
    code: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)],
    }),
    unitType: new FormControl<(typeof unitTypes)[number]>('department', { nonNullable: true }),
    parentId: new FormControl<string | null>(null),
    description: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(2000)],
    }),
  });

  ngOnInit(): void {
    if (this.auth.config()?.mode === 'password') this.load();
  }
  load(page = 1): void {
    const revision = ++this.listRevision;
    this.loading.set(true);
    this.error.set('');
    const params: Record<string, string> = {
      page: String(page),
      pageSize: '25',
      search: this.search,
      status: this.status,
      sort: this.sort,
    };
    if (this.type) params['unitType'] = this.type;
    if (this.view === 'tree') params['parentId'] = this.parentId ?? 'root';
    this.http.get<Page<OrganizationUnit>>(this.url, { params }).subscribe({
      next: (result) => {
        if (revision !== this.listRevision) return;
        this.rows.set(result);
        this.loading.set(false);
      },
      error: (error) => {
        if (revision !== this.listRevision) return;
        this.loading.set(false);
        this.fail(error);
      },
    });
  }
  navigate(unit: OrganizationUnit | null): void {
    if (this.busy()) return;
    this.notice.set('');
    this.parentId = unit?.id ?? null;
    this.selected.set(null);
    this.confirmation.set(null);
    this.memberRemoval.set(null);
    this.form.reset({
      name: '',
      code: '',
      unitType: 'department',
      description: '',
      parentId: this.parentId,
    });
    this.parentName = unit?.name ?? '';
    if (unit)
      this.http.get<OrganizationUnit[]>(`${this.url}/${unit.id}/ancestors`).subscribe({
        next: (path) => {
          if (this.parentId === unit.id) this.path.set(path);
        },
        error: (e) => {
          if (this.parentId === unit.id) this.fail(e);
        },
      });
    else this.path.set([]);
    this.load();
  }
  edit(unit: OrganizationUnit): void {
    if (this.busy()) return;
    this.selected.set(unit);
    this.confirmation.set(null);
    this.memberRemoval.set(null);
    this.notice.set('');
    this.form.setValue({
      name: unit.name,
      code: unit.code,
      unitType: unit.unitType,
      parentId: unit.parentId,
      description: unit.description,
    });
    this.parentName =
      unit.parentName ?? (unit.parentId ? 'Current parent (choose another to move)' : '');
    this.employeeId = '';
    this.employeeName = '';
    this.loadMembers();
  }
  create(): void {
    if (this.busy()) return;
    this.notice.set('');
    this.selected.set(null);
    this.parentName = this.path().at(-1)?.name ?? '';
    this.form.reset({
      name: '',
      code: '',
      unitType: 'department',
      description: '',
      parentId: this.parentId,
    });
  }
  chooseParent(item: { id: string; name: string } | null): void {
    this.form.controls.parentId.setValue(item?.id ?? null);
    this.parentName = item?.name ?? '';
  }
  chooseEmployee(item: { id: string; name: string }): void {
    this.employeeId = item.id;
    this.employeeName = item.name;
  }
  save(): void {
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    const previous = this.selected();
    const value = {
      ...this.form.getRawValue(),
      parentId: this.form.controls.parentId.value?.trim() || null,
    };
    const operation = previous
      ? this.http.put<OrganizationUnit>(`${this.url}/${previous.id}`, {
          ...value,
          version: previous.version,
        })
      : this.http.post<OrganizationUnit>(this.url, value);
    operation.subscribe({
      next: (unit) => {
        this.busy.set(false);
        this.edit(unit);
        this.notice.set('Structure saved.');
        this.load(this.rows().page);
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e);
      },
    });
  }
  archive(): void {
    const unit = this.confirmation();
    if (!unit || this.busy()) return;
    this.busy.set(true);
    this.http.post(`${this.url}/${unit.id}/archive`, { version: unit.version }).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmation.set(null);
        this.create();
        this.load();
        this.notice.set('Unit archived. Its history is retained.');
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e);
      },
    });
  }
  loadMembers(page = 1): void {
    const revision = ++this.memberRevision;
    const unit = this.selected();
    if (!unit) return;
    this.http
      .get<Page<UnitMembership>>(`${this.url}/${unit.id}/members`, {
        params: { page, pageSize: 25 },
      })
      .subscribe({
        next: (rows) => {
          if (this.selected()?.id === unit.id && revision === this.memberRevision)
            this.members.set(rows);
        },
        error: (e) => {
          if (this.selected()?.id === unit.id && revision === this.memberRevision) this.fail(e);
        },
      });
  }
  addMember(): void {
    const unit = this.selected();
    if (!unit || !this.employeeId || this.busy()) return;
    this.busy.set(true);
    this.http
      .post(`${this.url}/${unit.id}/members`, {
        employeeId: this.employeeId.trim(),
        membershipType: this.membershipType,
        isPrimary: this.isPrimary,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.employeeId = '';
          this.employeeName = '';
          this.isPrimary = false;
          this.loadMembers();
          this.notice.set('Membership saved.');
        },
        error: (e) => {
          this.busy.set(false);
          this.fail(e);
        },
      });
  }
  removeMember(): void {
    const unit = this.selected(),
      member = this.memberRemoval();
    if (!unit || !member || this.busy()) return;
    this.busy.set(true);
    this.http.delete(`${this.url}/${unit.id}/members/${member.id}`).subscribe({
      next: () => {
        this.busy.set(false);
        this.memberRemoval.set(null);
        this.loadMembers();
      },
      error: (e) => {
        this.busy.set(false);
        this.fail(e);
      },
    });
  }
  private fail(error: HttpErrorResponse): void {
    const code: string = error.error?.error ?? '';
    const messages: Record<string, string> = {
      UNIT_VERSION_CONFLICT:
        'This unit changed or was archived. Refresh and reopen it before saving.',
      HIERARCHY_CONFLICT:
        'This move creates a cycle, uses an archived parent, or this unit still has children, members, or active positions. Resolve those dependencies first.',
      HIERARCHY_CYCLE: 'A unit cannot be its own parent.',
      CODE_OR_MEMBERSHIP_CONFLICT:
        'This code or membership already exists, or the employee already has a primary unit.',
      UNIT_NOT_FOUND: 'That unit is not available in your organization.',
      EMPLOYEE_NOT_FOUND: 'That employee is not available in your organization.',
    };
    this.error.set(
      messages[code] ??
        'The request could not be completed. Check the fields and refresh before retrying.',
    );
  }
}
