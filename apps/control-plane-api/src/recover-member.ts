import { z } from 'zod';
import { loadAuthConfig } from './auth.js';
import { ControlPlaneDatabase } from './database.js';
import { activationUrl } from './organization-routes.js';

// Local operator authority is required. Verify the person's identity before sharing the output.
const config = loadAuthConfig();
if (config.mode !== 'password') throw new Error('RECOVERY_REQUIRES_PASSWORD_MODE');
const [organizationId, employeeId, purpose] = z
  .tuple([z.string().uuid(), z.string().uuid(), z.enum(['activate', 'reset'])])
  .parse(process.argv.slice(2));
const db = new ControlPlaneDatabase(undefined, false);
try {
  const result = db.issueOperatorLink(organizationId, employeeId, purpose);
  console.log(
    JSON.stringify(
      {
        employeeId,
        purpose,
        expiresAt: result.expiresAt,
        activationUrl: activationUrl(
          result.role === 'ADMIN' ? config.adminUrl : config.employeeUrl,
          result.token,
          purpose,
        ),
        delivery: 'MANUAL',
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
