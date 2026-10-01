import { createPrivateKey, createSign } from 'node:crypto';
import type {
  RepositoryCredential,
  SourceControlConnection,
} from '../../../../packages/contracts/src/credentials.js';
import type { SecretValue } from '../secrets/secret-broker.js';
import { sourceControlProfiles } from './source-control.js';

/** A credential failure. The code is safe to record; nothing provider-supplied is kept. */
export class CredentialIssueError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** One issued credential and how to withdraw it early, when the provider supports that. */
export interface IssuedCredential {
  credential: RepositoryCredential;
  /** Withdraws the credential at the provider. Never throws. */
  revoke?: () => Promise<void>;
}

/**
 * Turns a connection's secret into a credential for one repository (ADR 0031). Issuers
 * never log, persist or return provider responses; failures surface only as codes.
 */
export interface RepositoryCredentialIssuer {
  readonly mode: SourceControlConnection['credentialMode'];
  issue(
    connection: SourceControlConnection,
    repository: string,
    secret: SecretValue,
    signal: AbortSignal,
  ): Promise<IssuedCredential>;
}

/**
 * A read-only token held in the secret store: a GitHub fine-grained token or a Bitbucket
 * repository access token. The token's own scope is the provider-side limit, so an
 * administrator should create it for the allowed repositories with read access only.
 */
export class StaticTokenIssuer implements RepositoryCredentialIssuer {
  readonly mode = 'static_token' as const;

  async issue(
    connection: SourceControlConnection,
    _repository: string,
    secret: SecretValue,
  ): Promise<IssuedCredential> {
    return {
      credential: {
        scheme: 'basic',
        username: sourceControlProfiles[connection.provider].tokenUsername,
        password: secret.reveal(),
      },
    };
  }
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/**
 * GitHub App: for each lease, mint an installation token restricted to the one repository and
 * `contents: read`, and revoke it when the lease ends. The secret is the App's private key.
 * GitHub expires the token after an hour at most even if revocation never happens.
 */
export class GitHubAppIssuer implements RepositoryCredentialIssuer {
  readonly mode = 'github_app' as const;

  constructor(
    private readonly options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
  ) {}

  async issue(
    connection: SourceControlConnection,
    repository: string,
    secret: SecretValue,
    signal: AbortSignal,
  ): Promise<IssuedCredential> {
    if (connection.provider !== 'github' || !connection.appId || !connection.installationId)
      throw new CredentialIssueError('CREDENTIAL_MODE_INVALID');
    const call = (path: string, init: RequestInit) =>
      (this.options.fetch ?? fetch)(`${connection.apiBaseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 10_000)]),
      });
    let jwt: string;
    try {
      jwt = this.appJwt(connection.appId, secret);
    } catch {
      throw new CredentialIssueError('CREDENTIAL_SECRET_INVALID');
    }
    const name = repository.split('/')[1]!;
    let response: Response;
    try {
      response = await call(
        `/app/installations/${encodeURIComponent(connection.installationId)}/access_tokens`,
        {
          method: 'POST',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
          },
          body: JSON.stringify({ repositories: [name], permissions: { contents: 'read' } }),
        },
      );
    } catch {
      throw new CredentialIssueError('CREDENTIAL_PROVIDER_UNREACHABLE');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CredentialIssueError(`CREDENTIAL_PROVIDER_HTTP_${response.status}`);
    }
    const body = (await response.json().catch(() => ({}))) as {
      token?: unknown;
      repositories?: { full_name?: unknown }[];
      permissions?: Record<string, unknown>;
    };
    const token = typeof body.token === 'string' ? body.token : '';
    // Refuse a token broader than requested rather than trusting the request was honoured.
    const scopedToRepository =
      Array.isArray(body.repositories) &&
      body.repositories.length === 1 &&
      String(body.repositories[0]?.full_name ?? '').toLowerCase() === repository.toLowerCase();
    const readOnly =
      body.permissions !== undefined &&
      Object.entries(body.permissions).every(
        ([permission, level]) =>
          (permission === 'contents' || permission === 'metadata') && level === 'read',
      );
    const revoke = async () => {
      if (!token) return;
      try {
        const reply = await call('/installation/token', {
          method: 'DELETE',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
          },
        });
        await reply.body?.cancel().catch(() => {});
      } catch {
        // GitHub expires the token within the hour regardless.
      }
    };
    if (!/^[\x21-\x7e]{20,4096}$/.test(token) || !scopedToRepository || !readOnly) {
      await revoke();
      throw new CredentialIssueError('CREDENTIAL_SCOPE_UNEXPECTED');
    }
    return {
      credential: {
        scheme: 'basic',
        username: sourceControlProfiles.github.tokenUsername,
        password: token,
      },
      revoke,
    };
  }

  /** A 9-minute RS256 App JWT, backdated a minute for clock drift, as GitHub recommends. */
  private appJwt(appId: string, secret: SecretValue): string {
    const now = Math.floor((this.options.now ?? Date.now)() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const key = createPrivateKey(secret.reveal());
    return `${header}.${claims}.${base64url(signer.sign(key))}`;
  }
}
