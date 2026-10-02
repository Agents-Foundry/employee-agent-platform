import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // The results feed the pilot-readiness assessment (ADR 0038).
    reporters: ['default', 'json'],
    outputFile: { json: '../../.readiness/results/agent-runtime.json' },
    testTimeout: 30_000,
  },
});
