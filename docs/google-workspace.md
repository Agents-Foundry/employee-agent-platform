# Google Workspace sign-in and authorization

The browser admin and employee apps now use Google OpenID Connect authorization code flow with PKCE (S256), state, and nonce. The API exchanges the code server-side and verifies the ID token's RS256 signature against Google's published keys, issuer, client audience, expiry, issuance time, nonce, authorized party where present, verified email, and exact Workspace `hd` claim. No Google token is sent to the Angular applications or stored for subsequent API calls.

Google documents [`sub` as the stable account identifier and `hd` as the Workspace-domain check](https://developers.google.com/identity/openid-connect/reference). Email addresses and the authorization URL's `hd` hint do not authorize access. The implementation uses [`jose` JWT verification](https://github.com/panva/jose) and Google's [documented OpenID Connect flow](https://developers.google.com/identity/openid-connect/openid-connect).

## Local setup

1. In a Google Cloud project, configure the OAuth consent screen for your Workspace organization and create a **Web application** OAuth client. Register exactly `http://localhost:4100/api/auth/callback` as an authorized redirect URI. The OAuth client secret stays on the API server; do not paste it into a chat, browser form, or repository.
2. Copy `.env.example` to `.env` in the repository root. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_WORKSPACE_DOMAIN` to your actual values. Leave the three local URLs unchanged for the initial test. npm's API scripts load the root `.env`; inherited environment values take precedence.
3. Create `.data/google-memberships.json` in the repository root, initially containing `[]`. This is an operator-controlled allowlist, not a publicly writable resource.
4. Run `npm run dev:api`, `npm run start:admin`, and `npm run start:employee` in separate terminals. Use `localhost`, consistently, for all three apps.
5. Sign in once with your Workspace account. An unlisted, verified account receives `MEMBERSHIP_REQUIRED` and its own Google `subject` in the callback response; no application session is issued. Give that subject to the operator who manages the directory. A personal Google account or wrong Workspace domain is rejected earlier.
6. Add approved accounts to the directory using this format, then restart the API. The first administrator is explicitly assigned in this file; there is no automatic first-user privilege grant.

```json
[
  {
    "subject": "the-verified-google-subject",
    "employeeId": "admin-001",
    "organization": { "id": "org-your-company", "name": "Your Company", "slug": "your-company" },
    "displayName": "Workspace Administrator",
    "email": "admin@example.com",
    "role": "ADMIN",
    "team": "Administration"
  },
  {
    "subject": "another-verified-google-subject",
    "employeeId": "employee-001",
    "organization": { "id": "org-your-company", "name": "Your Company", "slug": "your-company" },
    "displayName": "QA Engineer",
    "email": "qa@example.com",
    "role": "EMPLOYEE",
    "team": "QA"
  }
]
```

7. Sign in again. The account's directory role determines which app can open. Employees request an agent; admins approve it; the employee verifies the manifest and starts a QA conversation. Google mode does not seed or offer the unassigned demo agent.

Both `.env` and `.data` are ignored by Git. Never commit actual client secrets or the membership directory. The file is authoritative for this Google issuer: restarting with an account omitted disables its membership and deletes its sessions. Roles are resolved from current membership on every request. Subject-to-employee and employee-to-organization reassignment is rejected to protect existing data; offboarding/reprovisioning needs new IDs. Operators must manage this file securely until directory administration is implemented.

## Sessions and access control

### Email/password login

Both browser login pages also accept administrator-provisioned **application passwords**. These are separate from Google passwords: never enter a Google password into Agents Foundry. Existing Google-only memberships remain password-disabled unless an operator adds `passwordHash` to their directory entry. There is no public signup, password-reset email, or automatic email-based Google account linking.

To provision a password, use a unique passphrase of 15–256 characters. In a local PowerShell terminal, run the following from the repository root. Input is hidden; the password is passed via stdin rather than command-line arguments or a file. Only the hash is printed.

```powershell
$foundryPassword = Read-Host 'New application password' -AsSecureString
try {
  [System.Net.NetworkCredential]::new('', $foundryPassword).Password | npx tsx apps/control-plane-api/src/hash-password.ts
} finally {
  $foundryPassword.Dispose()
  Remove-Variable foundryPassword
}
```

Add the resulting `scrypt$32768$8$3$...` value as `passwordHash` in the private membership JSON and restart the API. Deliver the password through an approved secure channel, not Git or chat. A password-only account can use an operator-generated unique `local:<UUID>` subject; it will not automatically acquire Google sign-in. Accounts supporting both methods must retain their verified Google subject. Google OAuth server configuration is still required for this combined sign-in deployment.

Passwords use random salts and Node's asynchronous scrypt with [OWASP's N=2^15, r=8, p=3 profile](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Login failures are generic, absent accounts perform dummy hashing, and requests are capped per source IP and normalized email (10 per 15 minutes), with at most four concurrent password checks. These limits are process-local; multi-instance deployments require a shared limiter. Reverse proxies currently share the loopback source IP, so configure trusted proxy handling and shared edge limits before wider deployment.

Changing or removing `passwordHash` and restarting revokes that account's existing sessions, including Google-issued application sessions. Removing a directory member disables both methods. Password login does **not** consult Google's account suspension or MFA policy: administrators must explicitly approve this alternative and use directory offboarding. Forgotten passwords are reset by the operator replacing the hash; no self-service recovery is available yet. The same browser-only session, CSRF, role, and tenant boundaries apply to both methods.

- Login transactions expire after ten minutes and can be consumed only once. A random HttpOnly browser cookie binds state, nonce, and PKCE verifier to the initiating browser.
- Application sessions expire after eight hours. Only hashes of random session tokens are stored in SQLite. Production cookies use `__Host-`, Secure, HttpOnly, Path=/, and SameSite=Lax. Local HTTP development omits Secure and the prefix.
- Signing in rotates the current browser session. Sign-out deletes that application session and clears its cookie; it does not sign the user out of Google globally. The UI destroys the application view when an API call reports an expired session.
- Every business endpoint requires an application session in Google mode. `x-actor-*` headers have no authority and are stripped by the browser interceptor. Tokens, email domains, and browser-supplied IDs cannot set roles.
- Mutations additionally require an exact configured UI Origin; missing, `null`, and foreign origins fail. SameSite cookies are an additional defense. State/nonce/PKCE and one-use transactions protect login callbacks.
- Employees can access their own conversations, manifests, and requests. Admins can review their organization's agents, approvals, provisioning, and lifecycle events, but cannot read other employees' conversations through the conversation API. Self-approval is rejected. Public callers cannot submit AGENT or SYSTEM messages.
- `/api/health`, `/api/auth/config`, and login/callback routes are public. The password endpoint accepts unauthenticated, origin-checked, throttled login attempts. The configuration endpoint exposes only authentication mode and Workspace domain. Logout is an origin-checked mutation.

## Explicit demo mode

`npm run dev:api:demo` retains the seeded local workflow. The browser displays a demo-mode banner and adds known demo identity headers to every API request. Unauthenticated business routes are no longer available, including in demo mode. Demo mode is rejected when `NODE_ENV=production`; there is no automatic fallback from failed Google sign-in or missing Google configuration.

## Deployment boundary

Configure HTTPS URLs with the same hostname for the API and browser apps (development may use different localhost ports). The production browser client uses its own origin's `/api`, which must be reverse-proxied to the loopback API listener; the two Angular apps can be served under distinct paths with corresponding Angular base-href builds. Register the deployed callback URL with Google. Secure cookies are chosen from the configured callback URL, not untrusted request headers. Review proxy rate-limiting behavior before a shared rollout.

This slice implements browser identity/RBAC and application-level tenant checks. It is not a full production deployment: managed PostgreSQL with database row-level isolation, vault-backed signing and model credentials, directory CRUD, and provider-side revocation integration remain separate work. Workspace suspension does not immediately revoke an existing local session unless the membership is removed; sessions have an eight-hour maximum lifetime. Use directory removal for immediate application offboarding.

Native Tauri Google sign-in is deliberately unavailable until a system-browser callback/deep-link flow is implemented and tested. Do not embed the Google login screen in a webview. The employee browser preview supports this flow today; native compilation still requires the Windows build toolchain.

## Verification

Automated tests use locally signed Google-shaped ID tokens and a mocked token endpoint, not a live Workspace tenant. They exercise signature and claim failures, PKCE request construction, callback replay and browser binding, domain/member rejection, sessions, CSRF, role changes, expiry, and two-organization data isolation. Live setup requires the operator's Google OAuth configuration and verified account subjects.
