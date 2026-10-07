import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// The pilot smoke test (ADR 0039): one QA run on the deployed pilot stack, opt-in and never
// for pull requests. It needs no local database; everything it touches is deployed.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  test: {
    include: ['test/**/*.smoke.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    fileParallelism: false,
    testTimeout: 3_600_000,
  },
});
