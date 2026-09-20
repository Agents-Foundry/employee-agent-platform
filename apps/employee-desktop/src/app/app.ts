import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type {
  BootstrapResponse,
  Conversation,
  ConversationDetail,
  QaRunResponse,
} from '@agents-foundry/contracts';

@Component({
  imports: [DatePipe, FormsModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = 'http://localhost:4100/api';

  protected readonly bootstrap = signal<BootstrapResponse | null>(null);
  protected readonly conversations = signal<Conversation[]>([]);
  protected readonly activeConversation = signal<ConversationDetail | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly lastRun = signal<QaRunResponse | null>(null);
  protected prompt =
    'Analyze the story, prepare regression coverage, and request approval before browser execution.';
  protected storyKey = 'STORY-142';
  protected targetUrl = 'https://staging.example.com';

  ngOnInit(): void {
    void this.initialize();
  }

  protected async startNewConversation(): Promise<void> {
    this.activeConversation.set(null);
    this.lastRun.set(null);
  }

  protected async selectConversation(conversation: Conversation): Promise<void> {
    try {
      const detail = await firstValueFrom(
        this.http.get<ConversationDetail>(`${this.apiUrl}/conversations/${conversation.id}`),
      );
      this.activeConversation.set(detail);
    } catch {
      this.error.set('The conversation could not be loaded.');
    }
  }

  protected async submit(): Promise<void> {
    if (this.busy() || !this.prompt.trim()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      let conversation = this.activeConversation();
      if (!conversation) {
        const bootstrap = this.bootstrap();
        if (!bootstrap?.agents[0]) throw new Error('BOOTSTRAP_MISSING');
        const created = await firstValueFrom(
          this.http.post<Conversation>(`${this.apiUrl}/conversations`, {
            employeeId: bootstrap.employee.id,
            agentId: bootstrap.agents[0].id,
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
        this.http.post<QaRunResponse>(`${this.apiUrl}/qa/runs`, {
          employeeId: this.bootstrap()!.employee.id,
          conversationId: conversation.id,
          storyKey: this.storyKey.trim().toUpperCase(),
          targetUrl: this.targetUrl.trim(),
        }),
      );
      this.lastRun.set(result);
      await this.selectConversation(conversation);
      await this.loadConversations();
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
