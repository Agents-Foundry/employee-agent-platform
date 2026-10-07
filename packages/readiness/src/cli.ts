import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assess,
  operationalRecord,
  outcomesFromVitest,
  type Assessment,
  type OperationalRecord,
  type TestOutcome,
} from './assess.js';

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
// ADR 0039: what pilot:validate and pilot:smoke recorded against the deployed pilot.
const operationalArgument = process.argv.indexOf('--operational');
const operationalDirectory =
  operationalArgument >= 0
    ? resolve(process.argv[operationalArgument + 1] ?? '')
    : join(root, '.readiness', 'operational');
let operational: OperationalRecord[] = [];
try {
  operational = readdirSync(operationalDirectory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const record = operationalRecord(
          JSON.parse(readFileSync(join(operationalDirectory, name), 'utf8')),
        );
        return record ? [record] : [];
      } catch {
        return [];
      }
    });
} catch {
  operational = [];
}
const report = assess(assessment, outcomes, { commit, operational });
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
console.log('Operational proofs (from the deployed pilot):');
for (const proof of report.liveProofs)
  console.log(`  ${proof.status.padEnd(7)} ${proof.id}: ${proof.reason}`);
console.log(
  report.readyForControlledPilot
    ? 'Ready for a controlled pilot: code and operational proofs pass, with the accepted limitations in the report.'
    : !report.codeProofsPassed
      ? 'Not ready for a controlled pilot: code proofs do not pass.'
      : `Code proofs pass. Not ready for a controlled pilot until every operational proof passes: ${report.liveProofs
          .filter((proof) => proof.status !== 'passed')
          .map((proof) => proof.id)
          .join(', ')}.`,
);
if (report.problems.length) {
  for (const problem of report.problems) console.error(`PROBLEM: ${problem}`);
  process.exit(1);
}
