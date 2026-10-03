import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitionProblems } from './definitions.js';
import { grafanaDashboard, neutralDefinitions, prometheusRules } from './render.js';
import { parseThresholds, resolveAlerts } from './thresholds.js';

/**
 * `npm run ops:render [-- --thresholds <file>] [--out <directory>]`: write the operator
 * dashboards and alerts (ADR 0039). Without a thresholds file the recommended values are used;
 * that rendering is what `operations/` in the repository holds.
 */
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const thresholdsPath = option('--thresholds') ?? process.env['OPS_ALERT_THRESHOLDS_PATH'];
const out = resolve(option('--out') ?? join(root, 'operations'));

const problems = definitionProblems();
if (problems.length) {
  for (const problem of problems) console.error(`PROBLEM: ${problem}`);
  process.exit(1);
}
let alerts;
try {
  alerts = resolveAlerts(
    thresholdsPath ? parseThresholds(JSON.parse(readFileSync(thresholdsPath, 'utf8'))) : undefined,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'prometheus-rules.yaml'), prometheusRules(alerts));
writeFileSync(
  join(out, 'grafana-dashboard.json'),
  `${JSON.stringify(grafanaDashboard(), null, 2)}\n`,
);
writeFileSync(
  join(out, 'operations.json'),
  `${JSON.stringify(neutralDefinitions(alerts), null, 2)}\n`,
);
const changed = alerts.filter((alert) => alert.overridden).map((alert) => alert.id);
console.log(
  `Wrote ${alerts.filter((alert) => alert.enabled).length} alerts and the dashboard to ${out}` +
    (changed.length
      ? ` (deployment settings for: ${changed.join(', ')})`
      : ' (recommended thresholds)'),
);
