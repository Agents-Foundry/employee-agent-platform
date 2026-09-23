import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadAuthConfig } from './auth.js';
import { ControlPlaneDatabase } from './database.js';
import { activationUrl, memberInput } from './organization-routes.js';

// Operator-only CLI, never a public signup endpoint. Input contains no passwords.
const config = loadAuthConfig();
if (config.mode !== 'password') throw new Error('CUSTOMER_ONBOARDING_REQUIRES_PASSWORD_MODE');
const filename = process.argv[2];
if (!filename) throw new Error('Usage: create-customer <private-customer-json-path>');
const input = z
  .object({
    organization: z
      .object({
        name: z.string().trim().min(1).max(200),
        slug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(80),
      })
      .strict(),
    admin: memberInput,
  })
  .strict()
  .parse(JSON.parse(readFileSync(filename, 'utf8')));
const db = new ControlPlaneDatabase(undefined, false);
try {
  const result = db.createCustomer(input.organization, input.admin);
  console.log(
    JSON.stringify(
      {
        organizationId: result.organizationId,
        expiresAt: result.expiresAt,
        activationUrl: activationUrl(config.adminUrl, result.token, result.purpose),
        purpose: result.purpose,
        delivery: 'MANUAL',
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
