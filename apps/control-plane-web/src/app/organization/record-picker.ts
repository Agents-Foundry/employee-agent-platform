import { Component, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import type { Page } from '../../../../../packages/contracts/src/organization';

@Component({
  selector: 'af-record-picker',
  imports: [FormsModule],
  template: `<div class="picker">
    <label
      >{{ label()
      }}<input
        [(ngModel)]="search"
        [ngModelOptions]="{ standalone: true }"
        maxlength="160"
        (keydown.enter)="$event.preventDefault(); find()"
        [disabled]="disabled()"
    /></label>
    <button type="button" (click)="find()" [disabled]="loading() || disabled()">Search</button>
    @if (error()) {
      <p role="alert">Search failed. Please try again.</p>
    }
    @if (results(); as page) {
      @for (item of page.items; track item.id) {
        <button type="button" (click)="choose(item)" [disabled]="disabled()">
          {{ item.name }}
        </button>
      } @empty {
        <small>No matches in your organization. Try another name.</small>
      }
      <div>
        <button
          type="button"
          (click)="find(page.page - 1)"
          [disabled]="page.page === 1 || loading()"
        >
          Previous</button
        ><small>{{ page.total }} matches</small
        ><button
          type="button"
          (click)="find(page.page + 1)"
          [disabled]="page.page * 10 >= page.total || loading()"
        >
          Next
        </button>
      </div>
    }
  </div>`,
  styles: [
    `
      .picker {
        display: grid;
        gap: 6px;
      }
      label {
        display: grid;
        gap: 6px;
      }
      input,
      button {
        font: inherit;
        border: 1px solid #d7dce7;
        border-radius: 8px;
        padding: 8px;
        background: white;
        color: #5141b5;
      }
      button {
        cursor: pointer;
      }
      small {
        color: #68718a;
        margin: 0 8px;
      }
    `,
  ],
})
export class RecordPicker {
  readonly url = input.required<string>();
  readonly label = input.required<string>();
  readonly disabled = input(false);
  readonly chosen = output<{ id: string; name: string }>();
  private readonly http = inject(HttpClient);
  readonly results = signal<Page<{ id: string; name: string }> | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  search = '';
  find(page = 1): void {
    if (this.loading() || this.disabled()) return;
    this.loading.set(true);
    this.error.set(false);
    this.http
      .get<Page<{ id: string; name: string }>>(this.url(), {
        params: { search: this.search, page, pageSize: 10 },
      })
      .subscribe({
        next: (result) => {
          this.results.set(result);
          this.loading.set(false);
        },
        error: () => {
          this.error.set(true);
          this.loading.set(false);
          this.results.set(null);
        },
      });
  }
  choose(item: { id: string; name: string }): void {
    this.chosen.emit(item);
    this.results.set(null);
    this.search = item.name;
  }
}
