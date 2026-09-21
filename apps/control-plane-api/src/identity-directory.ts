import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ControlPlaneDatabase } from './database.js';

const entry = z
  .object({
    subject: z.string().min(1).max(512),
    employeeId: z.string().min(1).max(120),
    organization: z
      .object({
        id: z.string().min(1).max(120),
        name: z.string().min(1).max(200),
        slug: z.string().min(1).max(120),
      })
      .strict(),
    displayName: z.string().min(1).max(200),
    email: z.email(),
    role: z.enum(['ADMIN', 'EMPLOYEE']),
    team: z.string().min(1).max(120),
  })
  .strict();
export type IdentityEntry = z.infer<typeof entry>;

export function syncIdentityDirectory(
  database: ControlPlaneDatabase,
  issuer: string,
  filename: string,
): void {
  const entries = z
    .array(entry)
    .max(10000)
    .parse(JSON.parse(readFileSync(filename, 'utf8')));
  if (
    new Set(entries.map((item) => item.subject)).size !== entries.length ||
    new Set(entries.map((item) => item.employeeId)).size !== entries.length
  )
    throw new Error('DUPLICATE_IDENTITY');
  database.syncIdentities(issuer, entries);
}
