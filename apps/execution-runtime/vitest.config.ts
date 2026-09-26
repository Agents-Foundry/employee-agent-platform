import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Real git and child processes: Windows process start-up is slow.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
