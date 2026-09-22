import { createApp } from './app.js';
import { loadAuthConfig, GOOGLE_ISSUER } from './auth.js';
import { ControlPlaneDatabase } from './database.js';
import { syncIdentityDirectory } from './identity-directory.js';

if (process.argv.includes('--demo')) process.env['AUTH_MODE'] = 'demo';
const auth = loadAuthConfig();
const database = new ControlPlaneDatabase(undefined, auth.mode === 'demo');
if (auth.mode === 'google') {
  const directory = process.env['IDENTITY_DIRECTORY_PATH'];
  if (!directory) throw new Error('IDENTITY_DIRECTORY_PATH_REQUIRED');
  syncIdentityDirectory(database, GOOGLE_ISSUER, directory);
}

const port = Number(process.env['PORT'] ?? 4100);
const server = createApp(database, auth).listen(port, '127.0.0.1', () => {
  console.log(`Agents Foundry control plane API listening on http://127.0.0.1:${port}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; stopping control plane API.`);
  server.close((error) => {
    database.close();
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
