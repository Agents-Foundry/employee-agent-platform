import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import type { Telemetry } from '../../../packages/telemetry/src/index.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * `GET /metrics` in Prometheus text format (ADR 0035), for the operator's scraper only. It is
 * outside `/api`, so sessions and cookies never reach it. The scraper presents the bearer
 * token kept in the file at `METRICS_TOKEN_PATH`; the file is read on each request, so the
 * token can be rotated without a restart. Without that setting the route does not exist.
 */
export function configureMetricsRoute(
  app: Express,
  telemetry: Telemetry,
  tokenPath: string | undefined = process.env['METRICS_TOKEN_PATH']?.trim() || undefined,
): void {
  if (!tokenPath) return;
  app.get('/metrics', async (request, response) => {
    let expected: string;
    try {
      expected = readFileSync(tokenPath, 'utf8').trim();
    } catch {
      expected = '';
    }
    const presented = /^Bearer (.+)$/.exec(request.header('authorization') ?? '')?.[1] ?? '';
    // Compared as digests, so neither length nor content leaks through timing.
    if (expected.length < 32 || !timingSafeEqual(digest(presented), digest(expected))) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      response.status(401).json({ error: 'METRICS_TOKEN_REQUIRED' });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.type('text/plain; version=0.0.4').send(await telemetry.metrics.prometheus());
  });
}
