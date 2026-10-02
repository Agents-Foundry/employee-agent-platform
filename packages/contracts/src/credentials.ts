// Secret and credential brokering (ADR 0031). Provider-neutral, pure types and constants.
// Nothing here ever carries a raw secret except `RepositoryCredential`, which exists only in
// the credential redemption response between the control plane and an execution runtime.

/** Source-control providers whose repositories can be checked out with brokered credentials. */
export const sourceControlProviders = ['github', 'bitbucket'] as const;
export type SourceControlProvider = (typeof sourceControlProviders)[number];

/**
 * How the control plane obtains a credential for a lease:
 * - `static_token`: a read-only token held in the secret store (a GitHub fine-grained token
 *   or a Bitbucket repository access token);
 * - `github_app`: a GitHub App private key in the secret store, from which a token limited
 *   to the one repository and `contents: read` is minted for each lease and revoked after it.
 */
export const credentialModes = ['static_token', 'github_app'] as const;
export type CredentialMode = (typeof credentialModes)[number];

/** An organization's connection to a source-control host. Holds secret references only. */
export interface SourceControlConnection {
  id: string;
  organizationId: string;
  provider: SourceControlProvider;
  name: string;
  /** Git host the connection authenticates to, for example `github.com`. */
  gitHost: string;
  /** Provider API origin, used only by the control plane (GitHub App token minting). */
  apiBaseUrl: string;
  credentialMode: CredentialMode;
  /** `secret://` reference to the token or the GitHub App private key. Never the value. */
  secretRef: string;
  /** GitHub App only. */
  appId?: string;
  installationId?: string;
  /** Repositories (`owner/name` or `workspace/repository`) checkouts may authenticate to. */
  allowedRepositories: string[];
  status: 'ACTIVE' | 'DISABLED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceControlConnectionInput {
  provider: SourceControlProvider;
  name: string;
  gitHost: string;
  apiBaseUrl: string;
  credentialMode: CredentialMode;
  secretRef: string;
  appId?: string;
  installationId?: string;
  allowedRepositories: string[];
}

export const credentialLeaseStatuses = [
  'ISSUED',
  'REDEEMED',
  'RELEASED',
  'REVOKED',
  'EXPIRED',
] as const;
export type CredentialLeaseStatus = (typeof credentialLeaseStatuses)[number];

/**
 * Non-secret metadata of one repository credential lease. A lease authorizes exactly one
 * redemption, by an execution runtime, for exactly one signed grant's `git.checkout`.
 */
export interface CredentialLease {
  id: string;
  organizationId: string;
  connectionId: string;
  provider: SourceControlProvider;
  repository: string;
  repositoryUrl: string;
  ref: string;
  operationKind: 'git.checkout';
  grantId: string;
  requestId: string;
  runId: string;
  employeeId: string;
  agentId: string;
  status: CredentialLeaseStatus;
  issuedAt: string;
  expiresAt: string;
  redeemedAt?: string;
  releasedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  outcome?: string;
}

/**
 * The credential binding inside a signed execution grant. It names the lease, never a secret;
 * only the execution runtime that holds the grant can redeem it, once.
 */
export interface GrantCredentialBinding {
  leaseId: string;
  provider: SourceControlProvider;
  gitHost: string;
}

export const credentialTransportPaths = {
  redeem: '/runtime/v1/credentials/redeem',
  release: '/runtime/v1/credentials/release',
} as const;

/** An execution runtime redeems the lease named by a grant it is about to execute. */
export interface CredentialRedeemRequest {
  leaseId: string;
  /** The complete signed grant; its signature, lease and operation are checked again. */
  grant: unknown;
}

/** HTTP Basic credentials for Git over HTTPS. Held in memory for one checkout only. */
export interface RepositoryCredential {
  scheme: 'basic';
  username: string;
  password: string;
}

export interface CredentialRedeemResponse {
  leaseId: string;
  credential: RepositoryCredential;
  /** The credential is refused by the execution runtime after this time. */
  expiresAt: string;
}

export const credentialReleaseOutcomes = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'INTERRUPTED',
] as const;
export type CredentialReleaseOutcome = (typeof credentialReleaseOutcomes)[number];

/** After the checkout ends, however it ends, the execution runtime releases the lease. */
export interface CredentialReleaseRequest {
  leaseId: string;
  grantId: string;
  outcome: CredentialReleaseOutcome;
}

export interface CredentialReleaseResponse {
  leaseId: string;
  status: CredentialLeaseStatus;
}

/**
 * Which secret holds an organization's key for a model provider (ADR 0034). A reference only:
 * no API ever returns the key.
 */
export interface ModelCredentialBinding {
  provider: string;
  secretRef: string;
  status: 'ACTIVE' | 'DISABLED';
  version: number;
  updatedAt: string;
  updatedBy: string;
}
