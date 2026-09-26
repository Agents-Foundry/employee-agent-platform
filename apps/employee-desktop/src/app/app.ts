import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type {
  BootstrapResponse,
  Conversation,
  ConversationDetail,
  QaRunResult,
  AgentRunDetail,
  AgentRunStatus,
  AgentBlueprint,
  ProvisioningRequest,
  KeySource,
  AnySignedAgentManifest,
  ManifestVerificationKey,
} from '@agents-foundry/contracts';
import { verifyManifest } from './verify-manifest';
import {
  manifestConfiguration,
  manifestSubject,
} from '../../../../packages/contracts/src/manifest.js';
import { API_URL } from '../../../../packages/web-auth/src/session';

const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

@Component({
  imports: [DatePipe, FormsModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  /** How often a followed generic run is refreshed while it is not terminal. */
  static followIntervalMs = 2000;

  private readonly http = inject(HttpClient);
  private readonly apiUrl = API_URL;

  protected readonly bootstrap = signal<BootstrapResponse | null>(null);
  protected readonly conversations = signal<Conversation[]>([]);
  protected readonly activeConversation = signal<ConversationDetail | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly lastRun = signal<QaRunResult | null>(null);
  /** Legacy static plan: shown as a plan card that waits for one approval. */
  protected readonly legacyRun = computed(() => {
    const run = this.lastRun();
    return run?.mode === 'LEGACY_STATIC_PLAN' ? run : null;
  });
  /** Generic runtime run (Phase F), followed through the execution API. */
  protected readonly runDetail = signal<AgentRunDetail | null>(null);
  protected readonly pendingApprovals = computed(
    () => this.runDetail()?.approvals.filter((approval) => approval.status === 'PENDING') ?? [],
  );
  protected readonly runActive = computed(() => {
    const detail = this.runDetail();
    return !!detail && !TERMINAL_RUN_STATUSES.includes(detail.run.status);
  });
  private followedRunId: string | null = null;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly blueprint = signal<AgentBlueprint | null>(null);
  protected readonly provisioning = signal<ProvisioningRequest[]>([]);
  protected readonly provisioningBusy = signal(false);
  protected readonly verifiedManifest = signal<AnySignedAgentManifest | null>(null);
  protected readonly verifiedProjectName = computed(() => {
    const manifest = this.verifiedManifest();
    return manifest ? String(manifestConfiguration(manifest.payload)['projectName'] ?? '') : '';
  });
  protected selectedAgentId = 'agent_qa_engineer';
  protected answers: Record<string, string | string[]> = {};
  protected provider = '';
  protected model = '';
  protected credentialMode: KeySource = 'ORGANIZATION_MANAGED';

  private actorHeaders() {
    const employee = this.bootstrap()!.employee;
    return {
      'x-actor-id': employee.id,
      'x-actor-role': 'EMPLOYEE',
      'x-organization-id': employee.organizationId,
    };
  }

  protected toggleAnswer(id: string, option: string, checked: boolean): void {
    const current = this.answers[id];
    const values = Array.isArray(current) ? current : [];
    this.answers[id] = checked ? [...values, option] : values.filter((value) => value !== option);
  }

  protected async refreshProvisioning(): Promise<void> {
    if (!this.bootstrap()) return;
    try {
      this.provisioning.set(
        await firstValueFrom(
          this.http.get<ProvisioningRequest[]>(`${this.apiUrl}/provisioning`, {
            headers: this.actorHeaders(),
          }),
        ),
      );
    } catch {
      this.error.set('Provisioning requests could not be loaded.');
    }
  }

  protected async requestAgent(): Promise<void> {
    if (this.provisioningBusy() || !this.blueprint()) return;
    this.provisioningBusy.set(true);
    this.error.set('');
    try {
      const blueprint = this.blueprint()!;
      await firstValueFrom(
        this.http.post(
          `${this.apiUrl}/provisioning`,
          {
            blueprintId: blueprint.id,
            blueprintVersion: blueprint.version,
            provider: this.provider,
            model: this.model,
            credentialMode: this.credentialMode,
            answers: this.answers,
          },
          { headers: this.actorHeaders() },
        ),
      );
      await this.refreshProvisioning();
    } catch {
      this.error.set(
        'Agent request failed. Complete every field and use HTTP(S) URLs without credentials.',
      );
    } finally {
      this.provisioningBusy.set(false);
    }
  }

  protected async useProvisionedAgent(request: ProvisioningRequest): Promise<void> {
    if (request.agentId) await this.useAssignedAgent(request.agentId);
  }

  protected async refreshAssignedAgents(): Promise<void> {
    if (this.busy() || this.provisioningBusy()) return;
    this.provisioningBusy.set(true);
    try {
      this.bootstrap.set(
        await firstValueFrom(this.http.get<BootstrapResponse>(`${this.apiUrl}/bootstrap`)),
      );
    } catch {
      this.error.set('Assigned agents could not be refreshed.');
    } finally {
      this.provisioningBusy.set(false);
    }
  }

  protected async useAssignedAgent(agentId: string): Promise<void> {
    if (this.busy() || this.provisioningBusy()) return;
    this.provisioningBusy.set(true);
    this.error.set('');
    try {
      const manifest = await this.fetchVerifiedManifest(agentId);
      this.verifiedManifest.set(manifest);
      this.selectedAgentId = manifestSubject(manifest.payload).agentId;
      this.targetUrl = String(manifestConfiguration(manifest.payload)['qaUrl']);
      await this.startNewConversation();
    } catch {
      this.error.set(
        'The signed agent configuration could not be verified. Agent selection was not changed.',
      );
    } finally {
      this.provisioningBusy.set(false);
    }
  }

  private async fetchVerifiedManifest(agentId: string): Promise<AnySignedAgentManifest> {
    const headers = this.actorHeaders();
    const [manifest, key] = await Promise.all([
      firstValueFrom(
        this.http.get<AnySignedAgentManifest>(`${this.apiUrl}/agents/${agentId}/manifest`, {
          headers,
        }),
      ),
      firstValueFrom(
        this.http.get<ManifestVerificationKey>(`${this.apiUrl}/manifest-key`, { headers }),
      ),
    ]);
    const employee = this.bootstrap()!.employee;
    if (
      !(await verifyManifest(manifest, key, {
        agentId,
        employeeId: employee.id,
        organizationId: employee.organizationId,
      }))
    )
      throw new Error('INVALID_MANIFEST');
    return manifest;
  }
  protected prompt =
    'Analyze the story, prepare regression coverage, and request approval before browser execution.';
  protected storyKey = 'STORY-142';
  protected targetUrl = 'https://staging.example.com';

  ngOnInit(): void {
    void this.initialize();
  }

  ngOnDestroy(): void {
    this.stopFollowing();
  }

  protected async startNewConversation(): Promise<void> {
    this.stopFollowing();
    this.activeConversation.set(null);
    this.lastRun.set(null);
  }

  /** Follow a generic run until it ends; the conversation reloads when the run changes. */
  private async followRun(runId: string): Promise<void> {
    this.stopFollowing();
    this.followedRunId = runId;
    await this.refreshRun(runId);
  }

  private stopFollowing(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    this.followedRunId = null;
    this.runDetail.set(null);
  }

  private async refreshRun(runId: string): Promise<void> {
    this.followTimer = null;
    let detail: AgentRunDetail;
    try {
      detail = await firstValueFrom(
        this.http.get<AgentRunDetail>(`${this.apiUrl}/execution/v1/runs/${runId}`),
      );
    } catch {
      if (this.followedRunId === runId) this.error.set('The run status could not be refreshed.');
      return;
    }
    if (this.followedRunId !== runId) return;
    const previous = this.runDetail();
    this.runDetail.set(detail);
    if (
      previous &&
      (previous.run.status !== detail.run.status || previous.steps.length !== detail.steps.length)
    )
      await this.reloadConversation();
    if (TERMINAL_RUN_STATUSES.includes(detail.run.status)) return;
    this.followTimer = setTimeout(() => void this.refreshRun(runId), App.followIntervalMs);
  }

  private async reloadConversation(): Promise<void> {
    const conversation = this.activeConversation();
    if (!conversation) return;
    try {
      const detail = await firstValueFrom(
        this.http.get<ConversationDetail>(`${this.apiUrl}/conversations/${conversation.id}`),
      );
      if (this.activeConversation()?.id === detail.id) this.activeConversation.set(detail);
    } catch {
      this.error.set('The conversation could not be refreshed.');
    }
  }

  protected async cancelRun(): Promise<void> {
    const runId = this.followedRunId;
    if (!runId) return;
    try {
      await firstValueFrom(this.http.post(`${this.apiUrl}/execution/v1/runs/${runId}/cancel`, {}));
    } catch {
      this.error.set('The run could not be cancelled.');
    }
    if (this.followTimer) clearTimeout(this.followTimer);
    await this.refreshRun(runId);
  }

  protected async selectConversation(conversation: Conversation): Promise<void> {
    if (this.activeConversation()?.id !== conversation.id) {
      this.stopFollowing();
      this.lastRun.set(null);
    }
    try {
      const detail = await firstValueFrom(
        this.http.get<ConversationDetail>(`${this.apiUrl}/conversations/${conversation.id}`),
      );
      const manifest =
        detail.agentId === 'agent_qa_engineer'
          ? null
          : await this.fetchVerifiedManifest(detail.agentId);
      this.verifiedManifest.set(manifest);
      this.selectedAgentId = detail.agentId;
      this.activeConversation.set(detail);
    } catch {
      this.error.set(
        'The conversation could not be loaded or its agent signature could not be verified.',
      );
    }
  }

  protected async submit(): Promise<void> {
    if (this.busy() || this.provisioningBusy() || !this.prompt.trim() || !this.selectedAgentId)
      return;
    this.busy.set(true);
    this.error.set('');
    try {
      let conversation = this.activeConversation();
      if (!conversation) {
        const bootstrap = this.bootstrap();
        if (!bootstrap) throw new Error('BOOTSTRAP_MISSING');
        const created = await firstValueFrom(
          this.http.post<Conversation>(`${this.apiUrl}/conversations`, {
            employeeId: bootstrap.employee.id,
            agentId: this.selectedAgentId,
            title: `${this.storyKey} QA validation`,
          }),
        );
        conversation = { ...created, messages: [] };
        this.activeConversation.set(conversation);
      }
      await firstValueFrom(
        this.http.post(`${this.apiUrl}/conversations/${conversation.id}/messages`, {
          author: 'EMPLOYEE',
          content: `${this.prompt.trim()}\nStory: ${this.storyKey}\nTarget: ${this.targetUrl}`,
        }),
      );
      const result = await firstValueFrom(
        this.http.post<QaRunResult>(`${this.apiUrl}/qa/runs`, {
          employeeId: this.bootstrap()!.employee.id,
          conversationId: conversation.id,
          storyKey: this.storyKey.trim().toUpperCase(),
          targetUrl: this.targetUrl.trim(),
          instructions: this.prompt.trim().slice(0, 2000),
        }),
      );
      this.lastRun.set(result);
      await this.selectConversation(conversation);
      await this.loadConversations();
      if (result.mode === 'GENERIC_RUNTIME') await this.followRun(result.agentRun.id);
    } catch {
      this.error.set('The request failed. Check the story key, target URL, and API connection.');
    } finally {
      this.busy.set(false);
    }
  }

  protected useExample(): void {
    this.storyKey = 'STORY-142';
    this.targetUrl = 'https://staging.example.com';
    this.prompt =
      'Read the acceptance criteria, map impacted paths, and prepare smoke plus regression coverage.';
  }

  private async initialize(): Promise<void> {
    try {
      const bootstrap = await firstValueFrom(
        this.http.get<BootstrapResponse>(`${this.apiUrl}/bootstrap`),
      );
      this.bootstrap.set(bootstrap);
      if (!bootstrap.agents.some((agent) => agent.id === 'agent_qa_engineer'))
        this.selectedAgentId = '';
      const blueprints = await firstValueFrom(
        this.http.get<AgentBlueprint[]>(`${this.apiUrl}/blueprints`, {
          headers: this.actorHeaders(),
        }),
      );
      this.blueprint.set(blueprints[0] ?? null);
      await this.refreshProvisioning();
      await this.loadConversations();
    } catch {
      this.error.set('The control plane API is offline. Start it with npm run dev:api.');
    }
  }

  private async loadConversations(): Promise<void> {
    const employee = this.bootstrap()?.employee;
    if (!employee) return;
    const conversations = await firstValueFrom(
      this.http.get<Conversation[]>(`${this.apiUrl}/conversations`, {
        params: { employeeId: employee.id },
      }),
    );
    this.conversations.set(conversations);
  }
}
