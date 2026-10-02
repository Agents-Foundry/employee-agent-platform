import { createApp } from './app.js';
import { loadAuthConfig, GOOGLE_ISSUER } from './auth.js';
import { ControlPlaneDatabase } from './database.js';
import { syncIdentityDirectory } from './identity-directory.js';
import { telemetryFromEnvironment } from '../../../packages/telemetry/src/index.js';

if (process.argv.includes('--demo')) process.env['AUTH_MODE'] = 'demo';
const auth = loadAuthConfig();
// ADR 0035: traces and metrics for this process.
const observability = telemetryFromEnvironment('control-plane');
const database = await ControlPlaneDatabase.open({
  seedDemo: auth.mode === 'demo',
  telemetry: observability.telemetry,
});
const stopTelemetry = observability.start();
if (auth.mode === 'google') {
  const directory = process.env['IDENTITY_DIRECTORY_PATH'];
  if (!directory) throw new Error('IDENTITY_DIRECTORY_PATH_REQUIRED');
  await syncIdentityDirectory(database, GOOGLE_ISSUER, directory);
}

// ADR 0024: alert webhooks are sent from this process when the operator enables them.
const stopWebhooks = database.alertWebhooks.options.enabled
  ? database.alertWebhooks.start(15_000)
  : () => undefined;

// ADR 0032 and 0033: abandoned runs are reaped and artifact retention is enforced from this
// process, as well as whenever runtimes poll.
// ADR 0036: a dispatch a stopped control plane left open is closed as unknown.
const housekeeping = setInterval(() => {
  void database.runtimeTransport.reapAbandoned().catch(() => undefined);
  void database.artifacts.enforceRetention().catch(() => undefined);
  void database.actions.reconcileInterrupted().catch(() => undefined);
}, 60_000);
housekeeping.unref();

const port = Number(process.env['PORT'] ?? 4100);
const server = createApp(database, auth).listen(port, '127.0.0.1', () => {
  console.log(`Agents Foundry control plane API listening on http://127.0.0.1:${port}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; stopping control plane API.`);
  stopWebhooks();
  clearInterval(housekeeping);
  server.close((error) => {
    void stopTelemetry()
      .then(() => database.close())
      .finally(() => process.exit(error ? 1 : 0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
