# Customer onboarding — first implementation slice

This slice adds database-managed organizations, first-admin activation, employee invitations, member listing and access revocation. It is separate from the existing file-managed Google pilot. It does not complete the entire customer-onboarding milestone.

## Deployment mode

Set `AUTH_MODE=password`, `ADMIN_APP_URL`, `EMPLOYEE_APP_URL`, and `DATABASE_PATH` in the private root `.env`. Google credentials and `IDENTITY_DIRECTORY_PATH` are not used in this mode. Existing Google pilot data is preserved, but Google identities cannot log in while password-only mode is selected. Use a separate database for a fresh customer pilot rather than switching an established customer's identity provider.

Use HTTPS in production, with both apps and the API on the same hostname. The API must be reverse-proxied under `/api`. Development permits localhost HTTP. Password sessions retain the existing eight-hour expiry, HttpOnly cookie, origin checks, role checks, and tenant scoping.

## Provision a purchased organization

Only a trusted platform operator can provision a purchase using this local CLI. There is no unauthenticated organization-creation endpoint and no automatic first-user admin grant.

Create an ignored `.data/new-customer.json` in the repository root:

```json
{
  "organization": { "name": "Example Company", "slug": "example-company" },
  "admin": { "displayName": "Customer Administrator", "email": "admin@example.com", "team": "Administration" }
}
```

From `apps/control-plane-api`, run:

```powershell
npx tsx --env-file=../../.env src/create-customer.ts ../../.data/new-customer.json
```

The CLI atomically creates the organization and a disabled ADMIN identity, then prints a private activation link. Share it with the named administrator using an approved secure channel. This is a bearer credential: do not put it in Git, public logs, or a support ticket. Only its SHA-256 hash is stored in the database. Links expire after 48 hours and can be redeemed once. The first admin's password is never selected by the platform operator.

The activation token is in the URL fragment, not the query string. The browser removes it from the address bar and keeps it in memory; refreshing before activation requires reopening the original invitation. Activation requires a 15–256-character password, stores a salted scrypt hash, and asks the customer to sign in. It does not silently replace an existing signed-in browser session.

## Organization administration

After activation, the admin app exposes an Organization members panel. Admins can invite EMPLOYEE accounts into their own organization, retrieve a private activation link once, and disable employees. Disabling an employee revokes their sessions and pending invitations immediately. Invited users cannot select their own role or organization. Admins cannot disable themselves or another admin through this initial UI.

Audit events record organization creation, invitations, activation, and disable actions without raw tokens or passwords. Existing email uniqueness means an address can belong to only one employee account across this deployment; multi-workspace users are not implemented yet.

## Remaining milestone work

- Transactional email delivery, invitation reissue, and password recovery (links are manually delivered in this slice).
- Organization profile setup, additional admins, role/team administration, and reactivation workflows.
- Admin-created agent configuration and assignment; existing employee request/admin approval flow remains available.
- Purchase webhook integration, idempotent provisioning, subscription and seat limits.
- Per-organization optional Google SSO and explicit identity linking; the legacy Google pilot still uses one configured domain.
- Production database/RLS, shared rate limiting, secret vaults, and operational hardening.

Do not describe this first slice as fully automated post-purchase onboarding. An expired first-admin invitation currently needs operator follow-up; reissue is the next lifecycle capability to implement before customer rollout.
