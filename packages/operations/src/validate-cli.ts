import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDependencies, summarize, validatePilot, type Scope } from './validate.js';

/**
 * `npm run pilot:validate [-- --scope control-plane|execution-host] [--out <file>] [--json]`
 * (ADR 0039). Run it with the pilot deployment's environment. It writes the machine-readable
 * report (by default to `.readiness/operational/pilot-validate.json`, where
 * `npm run readiness` reads operational proofs) and prints a summary, or the JSON with
 * `--json`. Exits non-zero when any check in scope fails.
 */
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const scopeArgument = option('--scope');
if (scopeArgument && !['control-plane', 'execution-host', 'all'].includes(scopeArgument)) {
  console.error('--scope must be control-plane, execution-host or all');
  process.exit(2);
}
const scopes: Scope[] =
  !scopeArgument || scopeArgument === 'all'
    ? ['control-plane', 'execution-host']
    : [scopeArgument as Scope];
const out = resolve(
  option('--out') ?? join(root, '.readiness', 'operational', 'pilot-validate.json'),
);

let commit = process.env['PILOT_RELEASE_COMMIT']?.trim() || null;
if (!commit)
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    commit = null;
  }

const report = await validatePilot({ ...defaultDependencies(process.env), commit }, scopes);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${summarize(report)}Report: ${out}\n`);
process.exit(report.passed ? 0 : 1);
