import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runSmoke,
  signIn,
  smokeConfig,
  summarizeSmoke,
} from '../../../packages/operations/src/smoke.js';

/**
 * `npm run pilot:smoke` (ADR 0039): drives one QA run on the deployed pilot stack and writes
 * `.readiness/operational/pilot-smoke.json`, the operational proofs `npm run readiness` reads.
 * `smokeConfig` refuses to start unless PILOT_SMOKE=true, outside pull-request events, with
 * targets declared disposable.
 */
const root = resolve(import.meta.dirname, '..', '..', '..');

describe('pilot smoke', () => {
  it('runs a story through the deployed stack, from story read to an approved draft write', async () => {
    const config = smokeConfig(process.env);
    let commit = process.env['PILOT_RELEASE_COMMIT']?.trim() || null;
    if (!commit)
      try {
        commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      } catch {
        commit = null;
      }
    const report = await runSmoke(config, {
      employee: await signIn(config, config.employee, 'employee'),
      admin: await signIn(config, config.admin, 'admin'),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      commit,
      environment: process.env['PILOT_ENVIRONMENT']?.trim() || 'pilot',
      secrets: [config.employee.password, config.admin.password],
    });
    const out = resolve(
      process.env['PILOT_SMOKE_REPORT'] ??
        join(root, '.readiness', 'operational', 'pilot-smoke.json'),
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(summarizeSmoke(report));
    expect(report.steps.filter((step) => step.status !== 'passed')).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
