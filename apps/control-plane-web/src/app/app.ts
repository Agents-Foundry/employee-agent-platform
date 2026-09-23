import { DatePipe } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { API_URL } from '../../../../packages/web-auth/src/session';
import { OrganizationAdmin } from './organization-admin';
import { AgentAdmin } from './agent-admin';
import { StructureAdmin } from './organization/structure-admin';
import { JobAdmin } from './organization/job-admin';
import { TenantAdmin } from './organization/tenant-admin';
import { PeopleAdmin } from './organization/people-admin';
import type {
  Approval,
  BootstrapResponse,
  ProvisioningRequest,
  LifecycleEvent,
} from '@agents-foundry/contracts';

@Component({
  imports: [
    DatePipe,
    FormsModule,
    OrganizationAdmin,
    AgentAdmin,
    StructureAdmin,
    JobAdmin,
    TenantAdmin,
    PeopleAdmin,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = API_URL;

  protected readonly bootstrap = signal<BootstrapResponse | null>(null);
  protected readonly approvals = signal<Approval[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly provisioning = signal<ProvisioningRequest[]>([]);
  protected readonly events = signal<LifecycleEvent[]>([]);
  protected readonly deciding = signal<string | null>(null);
  protected reasons: Record<string, string> = {};
  protected readonly pendingCount = computed(
    () =>
      this.approvals().filter((item) => item.status === 'PENDING').length +
      this.provisioning().filter((item) => item.status === 'PENDING').length,
  );
  protected readonly activeAgentCount = computed(
    () => this.bootstrap()?.agents.filter((item) => item.status === 'ACTIVE').length ?? 0,
  );

  ngOnInit(): void {
    this.refresh();
  }

  protected refresh(): void {
    this.loading.set(true);
    this.error.set('');
    this.http.get<BootstrapResponse>(`${this.apiUrl}/bootstrap`).subscribe({
      next: (bootstrap) => {
        this.bootstrap.set(bootstrap);
        this.loadApprovals();
        this.loadProvisioning();
      },
      error: () => {
        this.error.set('The control plane API is offline. Start it with npm run dev:api.');
        this.loading.set(false);
      },
    });
  }

  protected decide(approval: Approval, decision: 'APPROVED' | 'REJECTED'): void {
    const headers = new HttpHeaders({ 'x-actor-role': 'ADMIN', 'x-actor-id': 'admin_demo' });
    this.http
      .post<Approval>(`${this.apiUrl}/approvals/${approval.id}/decision`, { decision }, { headers })
      .subscribe({
        next: () => this.loadApprovals(),
        error: () => this.error.set('The decision could not be recorded. Refresh and try again.'),
      });
  }

  private actorHeaders() {
    return {
      'x-actor-id': 'admin_demo',
      'x-actor-role': 'ADMIN',
      'x-organization-id': this.bootstrap()!.organization.id,
    };
  }

  protected decideProvisioning(
    request: ProvisioningRequest,
    decision: 'APPROVED' | 'REJECTED',
  ): void {
    const reason = this.reasons[request.id]?.trim();
    if (!reason || this.deciding()) return;
    this.deciding.set(request.id);
    this.http
      .post(
        `${this.apiUrl}/provisioning/${request.id}/decision`,
        { decision, reason },
        { headers: this.actorHeaders() },
      )
      .subscribe({
        next: () => {
          this.deciding.set(null);
          this.refresh();
        },
        error: () => {
          this.deciding.set(null);
          this.error.set('Provisioning decision failed. Refresh to check its current status.');
        },
      });
  }

  private loadProvisioning(): void {
    const headers = this.actorHeaders();
    this.http.get<ProvisioningRequest[]>(`${this.apiUrl}/provisioning`, { headers }).subscribe({
      next: (requests) => this.provisioning.set(requests),
      error: () => this.error.set('Provisioning requests could not be loaded.'),
    });
    this.http.get<LifecycleEvent[]>(`${this.apiUrl}/lifecycle-events`, { headers }).subscribe({
      next: (events) => this.events.set(events),
      error: () => this.error.set('Lifecycle events could not be loaded.'),
    });
  }

  private loadApprovals(): void {
    this.http.get<Approval[]>(`${this.apiUrl}/approvals`).subscribe({
      next: (approvals) => {
        this.approvals.set(approvals);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Approvals could not be loaded.');
        this.loading.set(false);
      },
    });
  }
}
