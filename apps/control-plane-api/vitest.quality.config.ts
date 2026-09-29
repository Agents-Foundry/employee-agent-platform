import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Live model-quality evaluations (ADR 0020): real models, real tokens, run only on request.
// Settings may come from the repository's .env, like the development servers'.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  test: {
    include: ['test/**/*.live.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // One task at a time: the token ledger is shared and provider rate limits apply.
    fileParallelism: false,
    testTimeout: 900_000,
    globalSetup: ['test/support/postgres-setup.ts'],
    hookTimeout: 60_000,
  },
});
