import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  FormsModule,
  Validators,
} from '@angular/forms';
import { AuthSession, API_URL } from '../../../../../packages/web-auth/src/session';
import type {
  OrganizationProfile,
  TenantDomain,
} from '../../../../../packages/contracts/src/tenancy';

@Component({
  selector: 'af-tenant-admin',
  imports: [ReactiveFormsModule, FormsModule],
  templateUrl: './tenant-admin.html',
  styleUrl: './structure-admin.css',
})
export class TenantAdmin implements OnInit {
  protected readonly auth = inject(AuthSession);
  private readonly http = inject(HttpClient);
  private readonly base = `${API_URL}/organization`;
  readonly profile = signal<OrganizationProfile | null>(null);
  readonly domains = signal<TenantDomain[]>([]);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  domain = '';
  domainType: 'custom_domain' | 'platform_subdomain' = 'custom_domain';
  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(160)],
    }),
    legalName: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
    code: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)],
    }),
    slug: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        Validators.maxLength(80),
      ],
    }),
    website: new FormControl('', { nonNullable: true }),
    industry: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(160)] }),
    country: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(/^$|^[A-Z]{2}$/)],
    }),
    timezone: new FormControl('UTC', { nonNullable: true, validators: [Validators.required] }),
    locale: new FormControl('en', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^[a-z]{2}(?:-[A-Z]{2})?$/)],
    }),
  });
  ngOnInit(): void {
    if (this.auth.config()?.mode === 'password') this.refresh();
  }
  refresh(): void {
    this.loading.set(true);
    this.error.set('');
    this.http.get<OrganizationProfile>(`${this.base}/profile`).subscribe({
      next: (value) => {
        this.profile.set(value);
        this.form.setValue({
          name: value.name,
          legalName: value.legalName,
          code: value.code,
          slug: value.slug,
          website: value.website,
          industry: value.industry,
          country: value.country,
          timezone: value.timezone,
          locale: value.locale,
        });
        this.loading.set(false);
      },
      error: (error) => {
        this.loading.set(false);
        this.fail(error);
      },
    });
    this.loadDomains();
  }
  private loadDomains(): void {
    this.http
      .get<TenantDomain[]>(`${this.base}/domains`)
      .subscribe({ next: (rows) => this.domains.set(rows), error: (error) => this.fail(error) });
  }
  save(): void {
    const current = this.profile();
    if (!current || this.form.invalid || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    this.http
      .put<OrganizationProfile>(`${this.base}/profile`, {
        ...this.form.getRawValue(),
        version: current.version,
      })
      .subscribe({
        next: (value) => {
          this.busy.set(false);
          this.profile.set(value);
          this.notice.set('Organization profile saved.');
        },
        error: (error) => {
          this.busy.set(false);
          this.fail(error);
        },
      });
  }
  register(): void {
    if (!this.domain.trim() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    this.http
      .post<TenantDomain>(`${this.base}/domains`, {
        domain: this.domain,
        domainType: this.domainType,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.domain = '';
          this.loadDomains();
          this.notice.set('Domain registered. Add the displayed DNS TXT record, then verify.');
        },
        error: (error) => {
          this.busy.set(false);
          this.fail(error);
        },
      });
  }
  verify(item: TenantDomain): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post<TenantDomain>(`${this.base}/domains/${item.id}/verify`, {}).subscribe({
      next: () => {
        this.busy.set(false);
        this.loadDomains();
        this.notice.set(
          'Domain ownership verified. Configure HTTPS and routing before using it as a login URL.',
        );
      },
      error: (error) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }
  setPrimary(item: TenantDomain): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post<TenantDomain>(`${this.base}/domains/${item.id}/primary`, {}).subscribe({
      next: () => {
        this.busy.set(false);
        this.loadDomains();
        this.notice.set('Primary domain updated.');
      },
      error: (error) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }
  private fail(error: HttpErrorResponse): void {
    const code = error.error?.error;
    this.error.set(
      code === 'PROFILE_VERSION_CONFLICT'
        ? 'The profile changed. Refresh before saving.'
        : code === 'DOMAIN_PROOF_NOT_FOUND'
          ? 'DNS proof was not found. Confirm the TXT record name and value, then retry.'
          : code === 'TENANT_RECORD_CONFLICT'
            ? 'That code, slug or domain is already in use.'
            : code === 'DOMAIN_UNVERIFIED'
              ? 'Verify this domain before making it primary.'
              : 'The request failed. Check your entries and retry.',
    );
  }
}
