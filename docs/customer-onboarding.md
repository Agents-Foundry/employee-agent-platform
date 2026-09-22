# Customer onboarding and account recovery

Implemented so far: database-managed organizations, first-admin activation, employee invitations/reissue, member listing, administrator-assisted password recovery and access revocation. This is separate from the existing file-managed Google pilot and does not complete the entire customer-onboarding milestone.

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

- Transactional email delivery and self-service reset requests (reissue and administrator-assisted recovery are implemented; links are manually delivered).
- Organization profile setup, additional admins, role/team administration, and reactivation workflows.
- Admin-created agent configuration and assignment; existing employee request/admin approval flow remains available.
- Purchase webhook integration, idempotent provisioning, subscription and seat limits.
- Per-organization optional Google SSO and explicit identity linking; the legacy Google pilot still uses one configured domain.
- Production database/RLS, shared rate limiting, secret vaults, and operational hardening.

Do not describe the current implementation as fully automated post-purchase onboarding. Links still require manual secure delivery and identity verification.

## Invitation reissue and password recovery

The admin member panel distinguishes pending and expired invitations. **Reissue invitation** creates a new 48-hour activation link and invalidates the previous one. It preserves the original employee ID, role, organization, and email. It cannot recover disabled accounts or reset an already-active user's password.

For active employees, **Reset password** creates a one-hour, single-use reset link. Earlier reset links are invalidated. Merely issuing the link does not sign anyone out or change a password. Successful redemption atomically replaces the salted password hash, consumes all reset links for the account, and revokes all existing application sessions. It then asks the user to sign in, without automatically issuing a new session. Reset links cannot activate pending or disabled accounts, and activation links cannot reset passwords.

Admin-issued links are restricted to EMPLOYEE accounts in the admin's organization. The API ignores browser-supplied role/organization values and limits recovery-link issuance to ten attempts per admin per fifteen minutes. Redemption uses the existing origin checks, IP throttling, and bounded hashing concurrency. Limits remain process-local, so a shared limiter is required for multiple server instances.

For first-admin activation reissue or administrator password recovery, the platform operator can run this command from `apps/control-plane-api` after independently verifying the recipient's identity:

```powershell
npx tsx --env-file=../../.env src/recover-member.ts <organization-uuid> <employee-uuid> activate
# For an active administrator who has forgotten their password:
npx tsx --env-file=../../.env src/recover-member.ts <organization-uuid> <employee-uuid> reset
```

The CLI prints the private link once and uses the admin or employee app URL according to the stored role. No password is passed to the command. Local operator access is privileged: the operator must verify the organization, person, and delivery channel before sharing a link. Do not copy links to source control, public logs, or support tickets. The unauthenticated API never generates or discloses recovery links.

Links carry their token in the URL fragment. The UI immediately removes it from the address bar and keeps it only in memory. Refreshing requires reopening the original link. Account disable invalidates all outstanding activation and reset links; recovery never re-enables a disabled identity. Audit entries record link issuance/reissue and completed resets without raw tokens or passwords.
