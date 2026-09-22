import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthSession } from './session';

@Component({
  selector: 'af-auth-panel',
  imports: [FormsModule],
  templateUrl: './auth-panel.html',
  styleUrl: './auth-panel.css',
})
export class AuthPanel {
  readonly auth = inject(AuthSession);
  email = '';
  password = '';
  showPassword = false;
  showHelp = false;
  confirmation = '';
  async activate(): Promise<void> {
    if (this.password !== this.confirmation) {
      this.auth.error.set('Passwords do not match.');
      return;
    }
    const password = this.password;
    this.password = this.confirmation = '';
    await this.auth.activate(password);
  }
  async submit(): Promise<void> {
    const password = this.password;
    this.password = '';
    await this.auth.signInWithPassword(this.email, password);
  }
}
