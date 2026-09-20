import { DatePipe } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import type { Approval, BootstrapResponse } from '@agents-foundry/contracts';

@Component({
  imports: [DatePipe],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = 'http://localhost:4100/api';

  protected readonly bootstrap = signal<BootstrapResponse | null>(null);
  protected readonly approvals = signal<Approval[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly pendingCount = computed(
    () => this.approvals().filter((item) => item.status === 'PENDING').length,
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
