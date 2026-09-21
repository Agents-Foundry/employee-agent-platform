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
  async submit(): Promise<void> {
    const password = this.password;
    this.password = '';
    await this.auth.signInWithPassword(this.email, password);
  }
}
