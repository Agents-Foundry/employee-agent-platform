import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Password tests run fixed-cost scrypt (N=2^15) repeatedly; parallel files under coverage
    // exceed the 5 s default on slower developer machines.
    testTimeout: 30_000,
    // Each test clones its own PostgreSQL database from a migrated template (ADR 0018).
    globalSetup: ['test/support/postgres-setup.ts'],
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});
