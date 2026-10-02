import { randomUUID } from 'node:crypto';
import type { Actor, SignedExecutionGrant } from '@agents-foundry/contracts';
import type {
  CredentialLease,
  CredentialRedeemResponse,
  CredentialReleaseResponse,
  GrantCredentialBinding,
} from '../../../../packages/contracts/src/credentials.js';
import {
  parseCredentialRedeemRequest,
  parseCredentialReleaseRequest,
  parseSignedExecutionGrant,
} from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import type { PgStore, Row } from '../db/pg-store.js';
import { ExecutionError } from '../execution/execution-service.js';
import type { OrganizationStructureService } from '../organization/structure-service.js';
import type { Audit } from '../actions/action-policy-service.js';
import { servesOrganization, type RuntimeIdentity } from '../runtime/runtime-identity.js';
import { SecretUnavailable, type SecretBroker } from '../secrets/secret-broker.js';
import {
  CredentialIssueError,
  GitHubAppIssuer,
  StaticTokenIssuer,
  type RepositoryCredentialIssuer,
} from './credential-issuers.js';
import type { SourceControlConnectionService } from './source-control-connections.js';
import type { Telemetry } from '../../../../packages/telemetry/src/index.js';

/** How long an issued lease may wait to be redeemed and used (capped by the grant's expiry). */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export interface CredentialBrokerOptions {
  issuers?: readonly RepositoryCredentialIssuer[];
  leaseTtlMs?: number;
  now?: () => number;
  telemetry?: Telemetry;
}

interface CheckoutLeaseInput {
  run: Row;
  requestId: string;
  grantId: string;
  operation: { repositoryUrl: string; ref: string };
  operationDigest: string;
  /** The agent runtime that asked for the grant. */
  runtimeId: string;
  grantExpiresAt: string;
  nowMs: number;
}

/**
 * Issues, redeems, releases and revokes repository credential leases (ADR 0031).
 *
 * A lease is created with the signed grant for one `git.checkout`, in the same transaction,
 * after the gateway has authorized the organization, runtime, run lease, employee, agent,
 * signed manifest, exact repository, ref and operation. The grant names the lease; only an
 * execution runtime identity presenting that exact grant can redeem it, once, before it
 * expires, while the run is still running. The credential itself is resolved from the secret
 * broker at redemption and returned only to that runtime; it is never stored, logged, audited
 * or given to an agent runtime or model.
 */
export class CredentialBroker {
  private readonly issuers = new Map<string, RepositoryCredentialIssuer>();
  /** Provider-side revocation for credentials currently out, by lease. Memory only. */
  private readonly outstanding = new Map<string, () => Promise<void>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly telemetry: Telemetry | undefined;

  constructor(
    private readonly db: PgStore,
    private readonly secrets: SecretBroker,
    private readonly connections: SourceControlConnectionService,
    private readonly structure: OrganizationStructureService,
    private readonly verifyGrant: (grant: SignedExecutionGrant) => boolean,
    private readonly audit: Audit,
    options: CredentialBrokerOptions = {},
  ) {
    for (const issuer of options.issuers ?? [new StaticTokenIssuer(), new GitHubAppIssuer()])
      this.issuers.set(issuer.mode, issuer);
    this.ttlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.telemetry = options.telemetry;
  }

  /** Counted once the transaction that changed the lease has committed. */
  private counted(event: string, code = 'none'): void {
    this.db.afterCommit(() => this.telemetry?.count('af_credential_leases_total', { event, code }));
  }

  /**
   * The lease binding for a checkout, or null when no active connection authenticates that
   * repository (it is then checked out anonymously). Caller's tenant transaction, after the
   * grant has been fully authorized.
   */
  async leaseForCheckout(input: CheckoutLeaseInput): Promise<GrantCredentialBinding | null> {
    const organizationId = String(input.run['organization_id']);
    const match = await this.connections.forRepository(
      organizationId,
      input.operation.repositoryUrl,
    );
    if (!match) return null;
    const { connection, repository } = match;
    const id = randomUUID();
    const issuedAt = new Date(input.nowMs).toISOString();
    const expiresAt = new Date(
      Math.min(input.nowMs + this.ttlMs, Date.parse(input.grantExpiresAt)),
    ).toISOString();
    if (expiresAt <= issuedAt) throw new ExecutionError(409, 'GRANT_EXPIRED');
    await this.db.run(
      `INSERT INTO repository_credential_leases (id,organization_id,connection_id,provider,repository,
       repository_url,ref,operation_kind,operation_digest,grant_id,request_id,run_id,employee_id,agent_id,
       issued_to_runtime,status,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,'git.checkout',?,?,?,?,?,?,?,'ISSUED',?,?)`,
      id,
      organizationId,
      connection.id,
      connection.provider,
      repository,
      input.operation.repositoryUrl,
      input.operation.ref,
      input.operationDigest,
      input.grantId,
      input.requestId,
      String(input.run['id']),
      String(input.run['employee_id']),
      String(input.run['agent_id']),
      input.runtimeId,
      issuedAt,
      expiresAt,
    );
    await this.audit(
      String(input.run['agent_id']),
      'credential.lease.issued',
      'agent_run',
      String(input.run['id']),
      {
        leaseId: id,
        connectionId: connection.id,
        provider: connection.provider,
        repository,
        ref: input.operation.ref,
        grantId: input.grantId,
        expiresAt,
      },
      organizationId,
    );
    this.counted('issued');
    return { leaseId: id, provider: connection.provider, gitHost: connection.gitHost };
  }

  /** `POST /runtime/v1/credentials/redeem`: an execution runtime redeems a lease, once. */
  async redeem(runtime: RuntimeIdentity, body: unknown): Promise<CredentialRedeemResponse> {
    if (runtime.role !== 'execution') throw new ExecutionError(403, 'RUNTIME_ROLE_FORBIDDEN');
    const request = parseCredentialRedeemRequest(body);
    let grant: SignedExecutionGrant;
    try {
      grant = parseSignedExecutionGrant(request.grant);
    } catch {
      throw new ExecutionError(403, 'CREDENTIAL_GRANT_INVALID');
    }
    // Everything below trusts the grant only because the control plane signed it.
    if (!this.verifyGrant(grant)) throw new ExecutionError(403, 'CREDENTIAL_GRANT_INVALID');
    const { payload } = grant;
    if (payload.credential?.leaseId !== request.leaseId || payload.operationKind !== 'git.checkout')
      throw new ExecutionError(403, 'CREDENTIAL_LEASE_MISMATCH');
    const organizationId = payload.correlation.organizationId;
    if (!servesOrganization(runtime, organizationId))
      throw new ExecutionError(403, 'CREDENTIAL_ORGANIZATION_FORBIDDEN');
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    if (!(nowMs < Date.parse(payload.expiresAt)))
      throw new ExecutionError(403, 'CREDENTIAL_GRANT_EXPIRED');

    const authorized = await this.db.tenant(organizationId, async () => {
      const lease = await this.db.get(
        'SELECT * FROM repository_credential_leases WHERE id=? AND organization_id=? FOR UPDATE',
        request.leaseId,
        organizationId,
      );
      if (!lease) return { refused: 'CREDENTIAL_LEASE_UNKNOWN', status: 404 } as const;
      const refuse = async (code: string, status = 403, revoke = true) => {
        if (revoke && (lease['status'] === 'ISSUED' || lease['status'] === 'REDEEMED'))
          await this.transition(lease, 'REVOKED', nowIso, { by: runtime.id, reason: code });
        await this.audit(
          runtime.id,
          'credential.lease.refused',
          'agent_run',
          String(lease['run_id']),
          { leaseId: request.leaseId, code },
          organizationId,
        );
        this.counted('refused', code);
        return { refused: code, status } as const;
      };
      const status = String(lease['status']);
      if (status === 'REDEEMED' || status === 'RELEASED')
        return refuse('CREDENTIAL_LEASE_ALREADY_USED', 409);
      if (status === 'REVOKED') return refuse('CREDENTIAL_LEASE_REVOKED', 409, false);
      if (status === 'EXPIRED') return refuse('CREDENTIAL_LEASE_EXPIRED', 409, false);
      if (String(lease['expires_at']) <= nowIso) {
        await this.transition(lease, 'EXPIRED', nowIso);
        return refuse('CREDENTIAL_LEASE_EXPIRED', 409, false);
      }
      if (
        lease['grant_id'] !== payload.grantId ||
        lease['operation_digest'] !== payload.operationDigest ||
        lease['request_id'] !== payload.requestId ||
        lease['run_id'] !== payload.correlation.runId ||
        lease['employee_id'] !== payload.correlation.employeeId ||
        lease['agent_id'] !== payload.correlation.agentId
      )
        return refuse('CREDENTIAL_LEASE_MISMATCH');
      const run = await this.db.get<{ status: string; leased: string | null }>(
        `SELECT r.status, l.state AS leased FROM agent_runs r
         LEFT JOIN agent_run_leases l ON l.run_id=r.id
         WHERE r.id=? AND r.organization_id=?`,
        String(lease['run_id']),
        organizationId,
      );
      if (run?.status !== 'RUNNING' || run.leased !== 'ACTIVE')
        return refuse('CREDENTIAL_RUN_NOT_ACTIVE', 409);
      const connection = await this.connections.get(organizationId, String(lease['connection_id']));
      const current = await this.connections.forRepository(
        organizationId,
        String(lease['repository_url']),
      );
      if (
        connection?.status !== 'ACTIVE' ||
        current?.connection.id !== connection.id ||
        current.repository !== lease['repository']
      )
        return refuse('CREDENTIAL_CONNECTION_INACTIVE', 409);
      await this.transition(lease, 'REDEEMED', nowIso, { by: runtime.id });
      await this.audit(
        runtime.id,
        'credential.lease.redeemed',
        'agent_run',
        String(lease['run_id']),
        { leaseId: request.leaseId, grantId: payload.grantId },
        organizationId,
      );
      this.counted('redeemed');
      return { connection, lease };
    });
    if ('refused' in authorized) throw new ExecutionError(authorized.status, authorized.refused);

    const { connection, lease } = authorized;
    // The secret and the provider are reached outside any transaction.
    try {
      const issuer = this.issuers.get(connection.credentialMode);
      if (!issuer) throw new CredentialIssueError('CREDENTIAL_MODE_UNSUPPORTED');
      const secret = await this.secrets.resolve(organizationId, connection.secretRef);
      const issued = await issuer.issue(
        connection,
        String(lease['repository']),
        secret,
        AbortSignal.timeout(15_000),
      );
      if (issued.revoke) this.outstanding.set(request.leaseId, issued.revoke);
      return {
        leaseId: request.leaseId,
        credential: issued.credential,
        expiresAt: String(lease['expires_at']),
      };
    } catch (error) {
      const code =
        error instanceof SecretUnavailable || error instanceof CredentialIssueError
          ? error.code
          : 'CREDENTIAL_UNAVAILABLE';
      await this.revokeLease(organizationId, request.leaseId, runtime.id, code);
      this.telemetry?.count('af_credential_leases_total', { event: 'unavailable', code });
      throw new ExecutionError(502, 'CREDENTIAL_UNAVAILABLE');
    }
  }

  /**
   * `POST /runtime/v1/credentials/release`: the execution runtime that redeemed a lease ends it
   * after the checkout, however the checkout ended. Idempotent for that runtime.
   */
  async release(runtime: RuntimeIdentity, body: unknown): Promise<CredentialReleaseResponse> {
    if (runtime.role !== 'execution') throw new ExecutionError(403, 'RUNTIME_ROLE_FORBIDDEN');
    const request = parseCredentialReleaseRequest(body);
    const organizationId = await this.leaseOrganization(request.leaseId);
    if (!organizationId || !servesOrganization(runtime, organizationId))
      throw new ExecutionError(404, 'CREDENTIAL_LEASE_UNKNOWN');
    const nowIso = new Date(this.now()).toISOString();
    const status = await this.db.tenant(organizationId, async () => {
      const lease = await this.db.get(
        'SELECT * FROM repository_credential_leases WHERE id=? AND organization_id=? FOR UPDATE',
        request.leaseId,
        organizationId,
      );
      // Only the runtime that redeemed it may release it: leases are not transferable.
      if (!lease || lease['grant_id'] !== request.grantId || lease['redeemed_by'] !== runtime.id)
        throw new ExecutionError(404, 'CREDENTIAL_LEASE_UNKNOWN');
      if (lease['status'] !== 'REDEEMED') return String(lease['status']);
      await this.transition(lease, 'RELEASED', nowIso, { outcome: request.outcome });
      await this.audit(
        runtime.id,
        'credential.lease.released',
        'agent_run',
        String(lease['run_id']),
        { leaseId: request.leaseId, outcome: request.outcome },
        organizationId,
      );
      return 'RELEASED';
    });
    await this.withdraw(request.leaseId);
    return { leaseId: request.leaseId, status: status as CredentialReleaseResponse['status'] };
  }

  /** An administrator revokes a live lease of their organization. */
  revoke(actor: Actor, leaseId: string): Promise<CredentialLease> {
    return this.db
      .tenant(actor.organizationId, async () => {
        await this.structure.authorize(actor);
        const lease = await this.db.get(
          'SELECT * FROM repository_credential_leases WHERE id=? AND organization_id=? FOR UPDATE',
          leaseId,
          actor.organizationId,
        );
        if (!lease) throw new ExecutionError(404, 'CREDENTIAL_LEASE_UNKNOWN');
        if (lease['status'] !== 'ISSUED' && lease['status'] !== 'REDEEMED')
          throw new ExecutionError(409, 'CREDENTIAL_LEASE_NOT_LIVE');
        const nowIso = new Date(this.now()).toISOString();
        await this.transition(lease, 'REVOKED', nowIso, {
          by: actor.id,
          reason: 'REVOKED_BY_ADMINISTRATOR',
        });
        await this.audit(
          actor.id,
          'credential.lease.revoked',
          'agent_run',
          String(lease['run_id']),
          { leaseId, reason: 'REVOKED_BY_ADMINISTRATOR' },
          actor.organizationId,
        );
        return mapLease(
          (await this.db.get(
            'SELECT * FROM repository_credential_leases WHERE id=? AND organization_id=?',
            leaseId,
            actor.organizationId,
          ))!,
        );
      })
      .finally(() => this.withdraw(leaseId));
  }

  /** Revoke every live lease of a run that stopped (caller's tenant transaction). */
  async revokeForRun(organizationId: string, runId: string, reason: string): Promise<number> {
    const live = await this.db.all(
      `SELECT * FROM repository_credential_leases WHERE organization_id=? AND run_id=?
       AND status IN ('ISSUED','REDEEMED') FOR UPDATE`,
      organizationId,
      runId,
    );
    const nowIso = new Date(this.now()).toISOString();
    for (const lease of live) {
      await this.transition(lease, 'REVOKED', nowIso, { by: 'platform', reason });
      await this.audit(
        'platform',
        'credential.lease.revoked',
        'agent_run',
        runId,
        { leaseId: String(lease['id']), reason },
        organizationId,
      );
    }
    for (const lease of live) void this.withdraw(String(lease['id']));
    return live.length;
  }

  /** Expire every live lease past its deadline, in every organization. */
  async expireDue(): Promise<number> {
    const nowIso = new Date(this.now()).toISOString();
    const expired = await this.db.platform(async () => {
      const due = await this.db.all(
        `SELECT * FROM repository_credential_leases WHERE status IN ('ISSUED','REDEEMED')
         AND expires_at<=? FOR UPDATE`,
        nowIso,
      );
      for (const lease of due) {
        await this.transition(lease, 'EXPIRED', nowIso);
        await this.audit(
          'platform',
          'credential.lease.expired',
          'agent_run',
          String(lease['run_id']),
          { leaseId: String(lease['id']) },
          String(lease['organization_id']),
        );
      }
      return due.map((lease) => String(lease['id']));
    });
    for (const id of expired) await this.withdraw(id);
    return expired.length;
  }

  /** The newest leases of the administrator's organization. */
  list(actor: Actor): Promise<CredentialLease[]> {
    return this.db.tenant(actor.organizationId, async () => {
      await this.structure.authorize(actor);
      return (
        await this.db.all(
          'SELECT * FROM repository_credential_leases WHERE organization_id=? ORDER BY seq DESC LIMIT 100',
          actor.organizationId,
        )
      ).map(mapLease);
    });
  }

  private async revokeLease(
    organizationId: string,
    leaseId: string,
    by: string,
    reason: string,
  ): Promise<void> {
    await this.db.tenant(organizationId, async () => {
      const lease = await this.db.get(
        'SELECT * FROM repository_credential_leases WHERE id=? AND organization_id=? FOR UPDATE',
        leaseId,
        organizationId,
      );
      if (!lease || (lease['status'] !== 'ISSUED' && lease['status'] !== 'REDEEMED')) return;
      await this.transition(lease, 'REVOKED', new Date(this.now()).toISOString(), { by, reason });
      await this.audit(
        by,
        'credential.lease.revoked',
        'agent_run',
        String(lease['run_id']),
        { leaseId, reason },
        organizationId,
      );
    });
    await this.withdraw(leaseId);
  }

  private leaseOrganization(leaseId: string): Promise<string | null> {
    return this.db.platform(async () => {
      const row = await this.db.get<{ organization_id: string }>(
        'SELECT organization_id FROM repository_credential_leases WHERE id=?',
        leaseId,
      );
      return row?.organization_id ?? null;
    });
  }

  private async transition(
    lease: Row,
    status: 'REDEEMED' | 'RELEASED' | 'REVOKED' | 'EXPIRED',
    nowIso: string,
    details: { by?: string; reason?: string; outcome?: string } = {},
  ): Promise<void> {
    const id = String(lease['id']);
    const organizationId = String(lease['organization_id']);
    if (status === 'REDEEMED')
      await this.db.run(
        `UPDATE repository_credential_leases SET status='REDEEMED', redeemed_at=?, redeemed_by=?
         WHERE id=? AND organization_id=? AND status='ISSUED'`,
        nowIso,
        details.by!,
        id,
        organizationId,
      );
    else if (status === 'RELEASED')
      await this.db.run(
        `UPDATE repository_credential_leases SET status='RELEASED', released_at=?, outcome=?
         WHERE id=? AND organization_id=? AND status='REDEEMED'`,
        nowIso,
        details.outcome ?? null,
        id,
        organizationId,
      );
    else if (status === 'REVOKED')
      await this.db.run(
        `UPDATE repository_credential_leases SET status='REVOKED', revoked_at=?, revoked_by=?, revoke_reason=?
         WHERE id=? AND organization_id=? AND status IN ('ISSUED','REDEEMED')`,
        nowIso,
        details.by ?? 'platform',
        details.reason ?? 'REVOKED',
        id,
        organizationId,
      );
    else
      await this.db.run(
        `UPDATE repository_credential_leases SET status='EXPIRED'
         WHERE id=? AND organization_id=? AND status IN ('ISSUED','REDEEMED')`,
        id,
        organizationId,
      );
    if (status === 'REDEEMED') return;
    // The lease ended: one span from its issue to its end, under the grant that named it.
    const event = status.toLowerCase();
    const code = status === 'REVOKED' ? (details.reason ?? 'REVOKED') : (details.outcome ?? 'none');
    this.counted(event, code);
    this.db.afterCommit(() =>
      this.telemetry?.span({
        runId: String(lease['run_id']),
        name: 'credential.lease',
        subject: 'lease',
        id,
        parent: { subject: 'grant', id: String(lease['grant_id']) },
        startTimeMs: Date.parse(String(lease['issued_at'])),
        endTimeMs: Date.parse(nowIso),
        status: status === 'RELEASED' ? 'OK' : 'ERROR',
        attributes: {
          'af.organization.id': organizationId,
          'af.lease.id': id,
          'af.grant.id': String(lease['grant_id']),
          'af.request.id': String(lease['request_id']),
          'af.provider': String(lease['provider']),
          'af.status': status,
          ...(status === 'RELEASED' ? {} : { 'error.code': code }),
        },
      }),
    );
  }

  /** Withdraw a credential at its provider, if this instance issued one that can be. */
  private async withdraw(leaseId: string): Promise<void> {
    const revoke = this.outstanding.get(leaseId);
    this.outstanding.delete(leaseId);
    await revoke?.();
  }
}

export function mapLease(row: Row): CredentialLease {
  const optional = (column: string, key: keyof CredentialLease) =>
    row[column] === null || row[column] === undefined ? {} : { [key]: String(row[column]) };
  return {
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    connectionId: String(row['connection_id']),
    provider: String(row['provider']) as CredentialLease['provider'],
    repository: String(row['repository']),
    repositoryUrl: String(row['repository_url']),
    ref: String(row['ref']),
    operationKind: 'git.checkout',
    grantId: String(row['grant_id']),
    requestId: String(row['request_id']),
    runId: String(row['run_id']),
    employeeId: String(row['employee_id']),
    agentId: String(row['agent_id']),
    status: String(row['status']) as CredentialLease['status'],
    issuedAt: String(row['issued_at']),
    expiresAt: String(row['expires_at']),
    ...optional('redeemed_at', 'redeemedAt'),
    ...optional('released_at', 'releasedAt'),
    ...optional('revoked_at', 'revokedAt'),
    ...optional('revoke_reason', 'revokeReason'),
    ...optional('outcome', 'outcome'),
  };
}
