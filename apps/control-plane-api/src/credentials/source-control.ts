import type { SourceControlProvider } from '../../../../packages/contracts/src/credentials.js';

/** `owner/name` (GitHub) or `workspace/repository` (Bitbucket). */
export const repositoryNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * What differs between source-control providers for a brokered checkout. Everything else
 * (leases, binding, redemption, egress) is provider-neutral.
 */
export interface SourceControlProviderProfile {
  provider: SourceControlProvider;
  /** HTTP Basic user name git sends with a token. */
  tokenUsername: string;
  /** Default git host and API origin for the cloud service. */
  defaultGitHost: string;
  defaultApiBaseUrl: string;
}

export const sourceControlProfiles: Readonly<
  Record<SourceControlProvider, SourceControlProviderProfile>
> = {
  github: {
    provider: 'github',
    tokenUsername: 'x-access-token',
    defaultGitHost: 'github.com',
    defaultApiBaseUrl: 'https://api.github.com',
  },
  bitbucket: {
    provider: 'bitbucket',
    tokenUsername: 'x-token-auth',
    defaultGitHost: 'bitbucket.org',
    defaultApiBaseUrl: 'https://api.bitbucket.org/2.0',
  },
};

/**
 * The repository an HTTPS clone URL names on `gitHost`: `https://<host>/<owner>/<name>[.git]`
 * with nothing else (no credentials, port, query, fragment or extra path). Null otherwise.
 */
export function repositoryOf(repositoryUrl: string, gitHost: string): string | null {
  // Dot segments and escapes would be normalized into another path; refuse them outright.
  if (/\/\.{1,2}(\/|$)|[%\\\s]/.test(repositoryUrl)) return null;
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.hostname.toLowerCase() !== gitHost
  )
    return null;
  const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  return repositoryNamePattern.test(path) ? path : null;
}

/** Repository names compare case-insensitively on both providers. */
export function sameRepositoryName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
