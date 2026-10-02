import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // The results feed the pilot-readiness assessment (ADR 0038).
    reporters: ['default', 'json'],
    outputFile: { json: '../../.readiness/results/execution-runtime.json' },
    // Real git, child processes and Docker containers: Windows process start-up is slow.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
