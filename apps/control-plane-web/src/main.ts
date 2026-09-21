import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AuthRoot } from './app/auth-root';

bootstrapApplication(AuthRoot, appConfig).catch((err) => console.error(err));
