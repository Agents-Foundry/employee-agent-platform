import { describe, expect, it } from 'vitest';
import { MAX_RECONCILIATION_SUMMARY, redactSummary } from '../src/actions/action-reconciliation.js';

describe('reconciliation summaries', () => {
  it('removes anything shaped like a credential from what administrators are shown', () => {
    const cases = [
      `token=ghp_${'a1B2'.repeat(9)}`,
      `github_pat_${'x'.repeat(30)}`,
      'sk-live-0123456789abcdef',
      'AKIAABCDEFGHIJKLMNOP',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'Bearer abc.def.ghijklmnop',
      'password: hunter2hunter2',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl',
      'f'.repeat(40),
      'A'.repeat(48),
    ];
    for (const value of cases) {
      const shown = redactSummary(`Create Jira bug in QA: ${value} breaks login`);
      expect(shown, value).toContain('[redacted]');
      expect(shown, value).not.toContain(value);
    }
    expect(redactSummary('Clone https://bot:s3cr3t@git.example.com/acme/app')).toBe(
      'Clone https://[redacted]@git.example.com/acme/app',
    );
  });

  it('keeps an ordinary summary as it was written, on one bounded line', () => {
    const summary =
      'Open a draft pull request in acme/checkout from agents-foundry/fix-cart into main: "Fix cart". 2 file(s): src/cart.ts, src/cart.spec.ts. Change set 0123456789ab.';
    expect(redactSummary(summary)).toBe(summary);
    expect(redactSummary('Token refresh fails\nafter a day')).toBe(
      'Token refresh fails after a day',
    );
    const long = redactSummary('word '.repeat(200));
    expect(long.length).toBe(MAX_RECONCILIATION_SUMMARY);
    expect(long.endsWith('…')).toBe(true);
  });
});
