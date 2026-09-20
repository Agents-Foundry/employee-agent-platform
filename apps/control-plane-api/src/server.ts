import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4100);
const server = createApp().listen(port, '127.0.0.1', () => {
  console.log(`Agents Foundry control plane API listening on http://127.0.0.1:${port}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; stopping control plane API.`);
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
