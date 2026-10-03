import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assess, outcomesFromVitest, type Assessment, type TestOutcome } from './assess.js';

/**
 * `npm run readiness`: assess the commit from the test results the suites just wrote to
 * `.readiness/results/`, write `.readiness/pilot-readiness-report.json`, and fail when a
 * capability is below its minimum or a named proof did not run.
 */
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const resultsDirectory = join(root, '.readiness', 'results');
const assessment = JSON.parse(
  readFileSync(join(root, 'pilot-readiness', 'assessment.json'), 'utf8'),
) as Assessment;

let files: string[];
try {
  files = readdirSync(resultsDirectory).filter((name) => name.endsWith('.json'));
} catch {
  files = [];
}
const required = ['control-plane-api.json', 'agent-runtime.json', 'execution-runtime.json'];
const missing = required.filter((name) => !files.includes(name));
if (missing.length) {
  console.error(`No test results for: ${missing.join(', ')}. Run "npm run test" first.`);
  process.exit(1);
}
const outcomes: TestOutcome[] = files.flatMap((name) =>
  outcomesFromVitest(JSON.parse(readFileSync(join(resultsDirectory, name), 'utf8')), root),
);
let commit: string | null = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  // Not a checkout: the report simply names no commit.
}
const report = assess(assessment, outcomes, { commit });
mkdirSync(join(root, '.readiness'), { recursive: true });
writeFileSync(
  join(root, '.readiness', 'pilot-readiness-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`Pilot readiness for ${commit ?? 'this tree'}`);
console.log(
  `Tests: ${report.tests.passed} passed, ${report.tests.failed} failed, ${report.tests.skipped} skipped`,
);
for (const capability of report.capabilities) {
  console.log(`  ${capability.status.padEnd(5)} ${capability.title}`);
  for (const reason of capability.reasons) console.log(`          - ${reason}`);
}
console.log(
  report.readyForControlledPilot
    ? 'Ready for a controlled pilot, with the accepted limitations in the report.'
    : 'Not ready for a controlled pilot.',
);
if (report.problems.length) {
  for (const problem of report.problems) console.error(`PROBLEM: ${problem}`);
  process.exit(1);
}
