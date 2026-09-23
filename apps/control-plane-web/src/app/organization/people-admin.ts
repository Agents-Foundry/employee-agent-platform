import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  FormsModule,
  ReactiveFormsModule,
  FormGroup,
  FormControl,
  Validators,
} from '@angular/forms';
import { API_URL, AuthSession } from '../../../../../packages/web-auth/src/session';
import type {
  EmploymentRecord,
  OrganizationMembership,
} from '../../../../../packages/contracts/src/tenancy';
import type { Page } from '../../../../../packages/contracts/src/organization';
import { RecordPicker } from './record-picker';

@Component({
  selector: 'af-people-admin',
  imports: [FormsModule, ReactiveFormsModule, RecordPicker],
  templateUrl: './people-admin.html',
  styleUrl: './structure-admin.css',
})
export class PeopleAdmin implements OnInit {
  protected readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  readonly base = `${API_URL}/organization`;
  readonly rows = signal<Page<EmploymentRecord>>({ items: [], total: 0, page: 1, pageSize: 25 });
  readonly memberships = signal<Page<OrganizationMembership>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
  });
  readonly selected = signal<EmploymentRecord | null>(null);
  readonly position = signal<{ id: string; name: string } | null>(null);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly privateLink = signal('');
  readonly confirmation = signal<{ kind: 'inactive' | 'membership'; id: string } | null>(null);
  search = '';
  status = 'active';
  membershipSearch = '';
  employmentStatus: 'active' | 'inactive' = 'active';
  readonly form = new FormGroup({
    displayName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(200)],
    }),
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email, Validators.maxLength(254)],
    }),
    employeeNumber: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(60)],
    }),
    employmentType: new FormControl<'employee' | 'contractor' | 'external'>('employee', {
      nonNullable: true,
    }),
  });
  ngOnInit(): void {
    if (this.auth.config()?.mode === 'password') {
      this.load();
      this.loadMemberships();
    }
  }
  load(page = 1): void {
    this.loading.set(true);
    this.error.set('');
    this.http
      .get<Page<EmploymentRecord>>(`${this.base}/employees`, {
        params: { page, pageSize: 25, search: this.search, status: this.status },
      })
      .subscribe({
        next: (value) => {
          this.rows.set(value);
          this.loading.set(false);
        },
        error: (error) => {
          this.loading.set(false);
          this.fail(error);
        },
      });
  }
  loadMemberships(page = 1): void {
    this.http
      .get<Page<OrganizationMembership>>(`${this.base}/memberships`, {
        params: { page, pageSize: 25, search: this.membershipSearch },
      })
      .subscribe({
        next: (value) => this.memberships.set(value),
        error: (error) => this.fail(error),
      });
  }
  create(): void {
    if (this.busy()) return;
    this.selected.set(null);
    this.position.set(null);
    this.employmentStatus = 'active';
    this.form.reset({ displayName: '', email: '', employeeNumber: '', employmentType: 'employee' });
    this.confirmation.set(null);
  }
  edit(item: EmploymentRecord): void {
    if (this.busy()) return;
    this.selected.set(item);
    this.position.set(
      item.positionId
        ? { id: item.positionId, name: item.positionTitle ?? 'Current position' }
        : null,
    );
    this.employmentStatus = item.employmentStatus;
    this.form.setValue({
      displayName: item.displayName,
      email: item.email,
      employeeNumber: item.employeeNumber ?? '',
      employmentType: item.employmentType,
    });
    this.confirmation.set(null);
  }
  save(): void {
    if (this.form.invalid || this.busy()) return;
    const selected = this.selected(),
      value = this.form.getRawValue(),
      body = { ...value, employeeNumber: value.employeeNumber.trim() || null };
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    const operation = selected
      ? this.http.put<EmploymentRecord>(`${this.base}/employees/${selected.id}`, {
          ...body,
          employmentStatus: this.employmentStatus,
          version: selected.version,
        })
      : this.http.post<EmploymentRecord>(`${this.base}/employees`, body);
    operation.subscribe({
      next: (item) => {
        this.busy.set(false);
        this.edit(item);
        this.load(this.rows().page);
        this.notice.set(
          selected
            ? 'Employee updated.'
            : 'Employee record created. Invite them separately when they need application access.',
        );
      },
      error: (error) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }
  assign(positionId: string | null): void {
    const item = this.selected();
    if (!item || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.http
      .put<EmploymentRecord>(`${this.base}/employees/${item.id}/position`, {
        positionId,
        version: item.version,
      })
      .subscribe({
        next: (updated) => {
          this.busy.set(false);
          this.edit(updated);
          this.load(this.rows().page);
          this.notice.set(
            positionId ? 'Position assigned.' : 'Position ended; assignment history is retained.',
          );
        },
        error: (error) => {
          this.busy.set(false);
          this.fail(error);
        },
      });
  }
  invite(): void {
    const item = this.selected();
    if (!item || item.userId || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.privateLink.set('');
    this.http
      .post<{ activationUrl: string; purpose: 'link' | 'activate' }>(
        `${this.base}/employees/${item.id}/invitation`,
        {},
      )
      .subscribe({
        next: (value) => {
          this.busy.set(false);
          this.privateLink.set(value.activationUrl);
          this.load();
          this.loadMemberships();
          this.notice.set(
            value.purpose === 'link'
              ? 'Existing account found. Share the private link so its owner can sign in and approve this membership.'
              : 'Single-use invitation created. Share it through an approved private channel.',
          );
        },
        error: (error) => {
          this.busy.set(false);
          this.fail(error);
        },
      });
  }
  changeMembership(item: OrganizationMembership): void {
    if (this.busy()) return;
    const status = item.membershipStatus === 'active' ? 'suspended' : 'active';
    if (status === 'suspended' && this.confirmation()?.id !== item.id) {
      this.confirmation.set({ kind: 'membership', id: item.id });
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.http
      .put(`${this.base}/memberships/${item.id}/status`, { status, version: item.version })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.confirmation.set(null);
          this.loadMemberships();
          this.notice.set(`Membership ${status}.`);
        },
        error: (error) => {
          this.busy.set(false);
          this.fail(error);
        },
      });
  }
  confirmInactive(): void {
    const item = this.selected();
    if (!item || this.busy()) return;
    this.employmentStatus = 'inactive';
    this.confirmation.set(null);
    this.save();
  }
  private fail(error: HttpErrorResponse): void {
    const code = error.error?.error;
    this.error.set(
      code === 'POSITION_OCCUPIED'
        ? 'That position already has an employee. Choose another seat.'
        : code === 'TENANT_RECORD_CONFLICT'
          ? 'That email or employee number is already in use.'
          : code === 'EMPLOYEE_VERSION_CONFLICT' || code === 'MEMBERSHIP_VERSION_CONFLICT'
            ? 'This record changed. Refresh before saving.'
            : code === 'MEMBERSHIP_NOT_READY'
              ? 'The account must be active and the employee must be employed before reactivation.'
              : code === 'MEMBER_ALREADY_EXISTS'
                ? 'This employee already has a login membership.'
                : code === 'ACCOUNT_NOT_ACTIVE'
                  ? 'That existing account must be activated before it can join another organization.'
                  : 'The request failed. Check the fields and retry.',
    );
  }
}
