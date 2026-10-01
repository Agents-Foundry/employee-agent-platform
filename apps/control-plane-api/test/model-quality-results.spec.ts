/**
 * Model-quality results in the control plane (ADR 0026): the operator import, the overview
 * admins read, and the table's write protection.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelQualityOverview } from '@agents-foundry/contracts';
import type { ControlPlaneDatabase } from '../src/database.js';
import { HISTORY_VERSION, type HistoryRecord } from '../src/quality/quality-history.js';
import { ModelQualityService } from '../src/quality/quality-service.js';
import { createDemoApp } from './helpers.js';
import { testDatabase, testStore, type TestStore } from './support/database.js';
import { rawSql } from './support/raw-sql.js';

const org = 'org_agents_foundry';
const admin = { id: 'admin_demo', organizationId: org, role: 'ADMIN' as const };
const now = Date.parse('2026-09-30T12:00:00.000Z');

const record = (overrides: Partial<HistoryRecord> = {}): HistoryRecord => ({
  v: HISTORY_VERSION,
  runId: 'run-1',
  runAt: '2026-09-28T06:00:00.000Z',
  commit: 'abc1234',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  judgeModel: 'claude-opus-5-5',
  blueprint: 'engineering.qa-engineer@1.2.0',
  suite: 'qa-engineer',
  task: 'file-defect',
  trial: 1,
  passed: true,
  score: 0.9,
  passThreshold: 0.7,
  failedGates: [],
  runStatus: 'COMPLETED',
  tokens: 1500,
  estimatedCostUsd: 0.008,
  ...overrides,
});
/** One weekly run: `outcomes` are [passed, score] per trial. */
const run = (week: number, outcomes: [boolean, number][], overrides: Partial<HistoryRecord> = {}) =>
  outcomes.map(([passed, score], index) =>
    record({
      runId: `run-${week}`,
      runAt: new Date(Date.parse('2026-09-07T06:00:00.000Z') + week * 7 * 86_400_000).toISOString(),
      trial: index + 1,
      passed,
      score,
      ...overrides,
    }),
  );

describe('model-quality results', () => {
  let db: ControlPlaneDatabase;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('imports each result once, and keeps results unchangeable', async () => {
    const records = [
      ...run(0, [
        [true, 0.9],
        [true, 0.8],
      ]),
      ...run(1, [[true, 0.85]]),
    ];
    expect(await db.quality.import(records, now)).toEqual({ received: 3, imported: 3 });
    expect(await db.quality.import(records, now)).toEqual({ received: 3, imported: 0 });
    const rows = await rawSql(db)
      .prepare(
        'SELECT run_id, trial, passed, failed_gates, imported_at FROM model_quality_results ORDER BY run_id, trial',
      )
      .all();
    expect(rows[0]).toEqual({
      run_id: 'run-0',
      trial: 1,
      passed: true,
      failed_gates: '[]',
      imported_at: new Date(now).toISOString(),
    });
    // The platform role may only add results; triggers also stop the schema owner (below).
    const sql = rawSql(db);
    await expect(sql.prepare('UPDATE model_quality_results SET score=1').run()).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql.prepare('DELETE FROM model_quality_results').run()).rejects.toThrow(
      /permission denied/,
    );
    // Organizations read results but cannot write them.
    await expect(
      db.store.tenant(org, () =>
        db.store.run(
          `INSERT INTO model_quality_results (run_id,run_at,provider,model,judge_model,blueprint,suite,task,trial,passed,
           score,pass_threshold,failed_gates,run_status,tokens,imported_at)
           VALUES ('x','2026-09-01T00:00:00.000Z','p','m','j','b@1','s','t',1,true,1,1,'[]','COMPLETED',0,'2026-09-01T00:00:00.000Z')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('shows every series in the window to admins, with its trend', async () => {
    await db.quality.import(
      [
        ...run(0, [
          [true, 0.9],
          [true, 0.9],
          [true, 0.8],
        ]),
        ...run(1, [
          [true, 0.9],
          [false, 0.4],
          [false, 0.5],
        ]),
        // A model tried once and then dropped from the schedule still appears.
        ...run(0, [[false, 0.3]], { model: 'older-model' }),
        ...run(1, [[true, 0.9]], { blueprint: 'engineering.code-reviewer@1.0.0', task: 'review' }),
        // Outside the default window of 182 days.
        ...run(-40, [[true, 0.1]], { model: 'ancient-model' }),
      ],
      now,
    );
    const overview = await db.quality.overview(admin, {}, now);
    expect(overview.since).toBe(new Date(now - 182 * 86_400_000).toISOString());
    expect(overview.lastImportedAt).toBe(new Date(now).toISOString());
    expect(
      overview.series.map((series) => [
        series.blueprint,
        series.model,
        series.status,
        series.runs.length,
      ]),
    ).toEqual([
      ['engineering.code-reviewer@1.0.0', 'claude-sonnet-5-5', 'NEW', 1],
      ['engineering.qa-engineer@1.2.0', 'claude-sonnet-5-5', 'REGRESSED', 2],
      ['engineering.qa-engineer@1.2.0', 'older-model', 'NEW', 1],
    ]);
    const qa = overview.series.find((series) => series.status === 'REGRESSED')!;
    expect(qa.reasons).toEqual(['pass rate 100% → 33%', 'mean score 0.87 → 0.60']);
    expect(qa.latest).toMatchObject({ runId: 'run-1', trials: 3 });

    const forRole = await db.quality.overview(admin, { blueprint: 'engineering.qa-engineer' }, now);
    expect(forRole.series).toHaveLength(2);
    const forVersion = await db.quality.overview(
      admin,
      { blueprint: 'engineering.code-reviewer@1.0.0' },
      now,
    );
    expect(forVersion.series.map((series) => series.task)).toEqual(['review']);
    const longer = await db.quality.overview(admin, { days: '730' }, now);
    expect(longer.series.map((series) => series.model)).toContain('ancient-model');
  });

  it('is served to admins only, with validated filters', async () => {
    const app = createDemoApp(db);
    const as = (role: 'ADMIN' | 'EMPLOYEE', path: string) =>
      request(app)
        .get(`/api/catalog/v1/quality${path}`)
        .set({
          'x-actor-id': role === 'ADMIN' ? 'admin_demo' : 'employee_qa_demo',
          'x-actor-role': role,
          'x-organization-id': org,
        });
    const empty = (await as('ADMIN', '').expect(200)).body as ModelQualityOverview;
    expect(empty).toMatchObject({ lastImportedAt: null, series: [] });
    await as('EMPLOYEE', '').expect(403);
    for (const query of [
      '?days=1',
      '?days=9999',
      "?blueprint=x'%20OR%201=1",
      '?blueprint=a%25',
      '?other=1',
    ])
      await as('ADMIN', query).expect(400);
  });
});

describe('model-quality import command', () => {
  let store: TestStore;
  let directory: string;
  beforeEach(async () => {
    store = await testStore();
    directory = mkdtempSync(join(tmpdir(), 'af-quality-import-'));
  });
  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true });
    await store.drop();
  });

  const importFile = (content: string) => {
    const path = join(directory, 'quality-history.jsonl');
    writeFileSync(path, content);
    return promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'src/db/cli.ts', 'import-quality', path],
      {
        env: {
          ...process.env,
          DATABASE_URL: store.urls.tenant,
          DATABASE_PLATFORM_URL: store.urls.platform,
        },
      },
    );
  };

  it('imports a history file, and refuses one with a malformed line without importing any of it', async () => {
    const lines = run(0, [
      [true, 0.9],
      [false, 0.4],
    ]).map((item) => JSON.stringify(item));
    const imported = await importFile(`${lines.join('\n')}\n`);
    expect(imported.stdout).toContain('Imported 2 of 2 quality results.');
    expect((await importFile(`${lines.join('\n')}\n`)).stdout).toContain('Imported 0 of 2');

    const fresh = run(1, [[true, 0.9]]).map((item) => JSON.stringify(item));
    const failure = await importFile(`${fresh[0]}\n{"v":1,"note":"do-not-echo"}\n`).catch(
      (error: { stderr: string }) => error,
    );
    expect((failure as { stderr: string }).stderr).toContain('QUALITY_HISTORY_INVALID: line 2');
    expect((failure as { stderr: string }).stderr).not.toContain('do-not-echo');
    const service = new ModelQualityService(store.store);
    const overview = await service.overview(admin, { days: '730' }, now);
    expect(overview.series[0]!.runs.map((point) => point.runId)).toEqual(['run-0']);

    // Even the schema owner cannot change or delete a result.
    const owner = new pg.Client({ connectionString: store.urls.owner });
    await owner.connect();
    try {
      await expect(owner.query('UPDATE model_quality_results SET score=1')).rejects.toThrow(
        'MODEL_QUALITY_RESULT_IMMUTABLE',
      );
      await expect(owner.query('DELETE FROM model_quality_results')).rejects.toThrow(
        'MODEL_QUALITY_RESULT_IMMUTABLE',
      );
    } finally {
      await owner.end();
    }
  });
});
