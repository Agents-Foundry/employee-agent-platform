import { createHash, randomUUID } from 'node:crypto';
import type {
  AnySignedAgentManifest,
  ApprovalRisk,
  ExecutionGrantPayload,
  ExecutionOperation,
  SignedExecutionGrant,
  ConnectorConnection,
  ResolvedBlueprintBundle,
  RuntimeActionDecision,
  RuntimeActionExecution,
  RuntimeActionRequest,
} from '@agents-foundry/contracts';
import {
  evaluateActionPolicy,
  type ActionPolicyDecision,
} from '../../../../packages/policy-engine/src/index.js';
import { canonicalManifest } from '../../../../packages/contracts/src/manifest.js';
import { EXECUTION_GRANT_KIND } from '../../../../packages/contracts/src/execution-runtime/v1/protocol.js';
import { ExecutionError, type ExecutionService } from '../execution/execution-service.js';
import { controlPlaneAction, type ChangeSet, type ControlPlaneAction } from './action-registry.js';
import {
  DEFAULT_MAX_PROCESSES,
  executionAction,
  type ExecutionAction,
} from './execution-actions.js';
import { parseExecutionOperation } from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import type { ActionPolicyService, Audit } from './action-policy-service.js';
import type { PgStore, Row } from '../db/pg-store.js';
import { ConnectorError } from './connectors/jira.js';
import type { ConnectorService } from './connector-service.js';
import { SecretUnavailable, type SecretBroker } from '../secrets/secret-broker.js';
import type { CredentialBroker } from '../credentials/credential-broker.js';

export interface ActionGatewayDependencies {
  loadManifest: (
    agentId: string,
    organizationId: string,
    employeeId: string,
  ) => Promise<AnySignedAgentManifest>;
  bundle: (blueprintId: string, version: string) => Promise<ResolvedBlueprintBundle>;
  audit: Audit;
  connectors: ConnectorService;
  policies: ActionPolicyService;
  /** Connector credentials, resolved through the secret broker at dispatch (ADR 0031). */
  secrets: Pick<SecretBroker, 'resolve'>;
  /** Repository credential leases for authenticated checkouts (ADR 0031). */
  credentials?: Pick<CredentialBroker, 'leaseForCheckout'>;
  evaluate?: typeof evaluateActionPolicy;
  /** Signs execution grants with the control-plane key (ADR 0013). */
  signGrant: (payload: ExecutionGrantPayload) => SignedExecutionGrant;
  /** Connector HTTP client (tests); defaults to global fetch. */
  fetch?: typeof fetch;
  dispatchTimeoutMs?: number;
}

interface Assessment {
  outcome: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  risk: ApprovalRisk;
  reason: string;
  policy: ActionPolicyDecision | null;
  handler: ControlPlaneAction | null;
  parameters: Record<string, unknown> | null;
  connection: ConnectorConnection | null;
  /** Control-plane-written summary and target for approvals; null for parameterless actions. */
  summary: string | null;
  resource: { type: string; id: string } | null;
  /** Workspace changes an action publishes (Phase G). */
  changes: ChangeSet | null;
  /** Present for execution-runtime actions (ADR 0013). */
  execution: {
    policy: ExecutionAction;
    operation: ExecutionOperation;
    isolation: 'sandboxed' | 'local';
    timeoutMs: number;
  } | null;
}

/** A dispatch the gateway has committed to (row inserted as DISPATCHING) but not yet run. */
export interface PendingDispatch {
  requestId: string;
  organizationId: string;
  runId: string;
  agentId: string;
  action: string;
  handler: ControlPlaneAction;
  parameters: Record<string, unknown>;
  connection: ConnectorConnection;
  secret: string;
  changes: ChangeSet | null;
}

/** Limits on a published change set; larger changes are denied, never truncated. */
export const MAX_CHANGE_SET_FILES = 100;
export const MAX_CHANGE_SET_BYTES = 1024 * 1024;

export type ExecutionPlan =
  | { kind: 'done'; execution: RuntimeActionExecution }
  | { kind: 'dispatch'; dispatch: PendingDispatch };

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalManifest(value)).digest('hex');
}

/**
 * The Action Gateway (ADR 0005, ADR 0012). Decides governed actions with Policy v2, creates
 * payload-bound, expiring approvals, and executes control-plane-owned actions exactly once
 * through a connector. Every unknown or unverifiable input is a denial.
 */
export class ActionGateway {
  private readonly evaluate: typeof evaluateActionPolicy;

  constructor(
    private readonly db: PgStore,
    private readonly execution: ExecutionService,
    private readonly deps: ActionGatewayDependencies,
  ) {
    this.evaluate = deps.evaluate ?? evaluateActionPolicy;
  }

  /**
   * Decide and record one action request for a RUNNING run and step (caller's transaction).
   * `REQUIRE_APPROVAL` creates the approval and pauses the run atomically.
   */
  decide(
    runtimeId: string,
    run: Row,
    request: RuntimeActionRequest,
    requestHash: string,
  ): Promise<RuntimeActionDecision> {
    const organizationId = String(run['organization_id']);
    return this.db.tenant(organizationId, async () => {
      const verdict = await this.assess(run, request);
      const now = new Date();
      const approvalId = verdict.outcome === 'REQUIRE_APPROVAL' ? randomUUID() : null;
      const summary = verdict.summary ?? request.summary;
      if (approvalId) {
        const ttl = verdict.policy?.conditions.find(
          (condition) => condition.type === 'APPROVAL_TTL_SECONDS',
        );
        const expiresAt = new Date(now.getTime() + (ttl ? ttl.value : 3600) * 1000).toISOString();
        const resource = verdict.resource;
        await this.db.run(
          `INSERT INTO approvals (id, organization_id, requested_by, action, resource_type, resource_id,
           risk, summary, status, created_at, run_id, step_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          approvalId,
          organizationId,
          String(run['employee_id']),
          request.action,
          resource?.type ?? 'agent_run',
          resource?.id ?? String(run['id']),
          verdict.risk,
          summary,
          'PENDING',
          now.toISOString(),
          String(run['id']),
          request.correlation.stepId,
          expiresAt,
        );
        await this.execution.pauseForApproval(
          organizationId,
          String(run['id']),
          request.correlation.stepId,
          {
            id: approvalId,
            action: request.action,
            risk: verdict.risk,
            summary,
          },
        );
      }
      const decision =
        verdict.outcome === 'ALLOW'
          ? 'ALLOWED'
          : verdict.outcome === 'DENY'
            ? 'DENIED'
            : 'APPROVAL_REQUIRED';
      await this.db.run(
        `INSERT INTO agent_action_requests (id, organization_id, run_id, step_id, runtime_id, action, tool_id,
         request_hash, decision, risk, reason, approval_id, created_at, parameters, policy_id, policy_version,
         change_set) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        request.requestId,
        organizationId,
        String(run['id']),
        request.correlation.stepId,
        runtimeId,
        request.action,
        request.toolId,
        requestHash,
        decision,
        verdict.risk,
        verdict.reason,
        approvalId,
        now.toISOString(),
        // Only executable payloads are kept; denied payloads are not retained.
        verdict.outcome !== 'DENY' && verdict.parameters
          ? JSON.stringify(verdict.parameters)
          : null,
        verdict.policy?.policyId ?? null,
        verdict.policy?.policyVersion ?? null,
        verdict.outcome !== 'DENY' && verdict.changes ? JSON.stringify(verdict.changes) : null,
      );
      await this.deps.audit(
        String(run['agent_id']),
        `runtime.action.${decision.toLowerCase()}`,
        'agent_run',
        String(run['id']),
        {
          action: request.action,
          toolId: request.toolId,
          runtimeId,
          requestId: request.requestId,
          ...(verdict.policy
            ? { policyId: verdict.policy.policyId, policyVersion: verdict.policy.policyVersion }
            : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        organizationId,
      );
      return this.storedDecision(
        (await this.db.get(
          'SELECT * FROM agent_action_requests WHERE id=? AND organization_id=?',
          request.requestId,
          organizationId,
        ))!,
      );
    });
  }

  storedDecision(row: Row): RuntimeActionDecision {
    const base = {
      requestId: String(row['id']),
      risk: String(row['risk']) as ApprovalRisk,
      reason: String(row['reason']),
    };
    const decision = String(row['decision']);
    if (decision === 'APPROVAL_REQUIRED')
      return { ...base, decision, approvalId: String(row['approval_id']) };
    return { ...base, decision: decision === 'ALLOWED' ? 'ALLOWED' : 'DENIED' };
  }

  /**
   * First half of execution (caller's transaction; run and step already checked RUNNING).
   * Re-authorizes against current policy, the approval and its expiry, then commits to a single
   * dispatch. Denials are recorded as FAILED executions so the request can never be retried.
   */
  prepareExecution(
    run: Row,
    requestId: string,
    stepId: string,
    nowMs = Date.now(),
  ): Promise<ExecutionPlan> {
    const organizationId = String(run['organization_id']);
    return this.db.tenant(organizationId, async () => {
      await this.expireDue(nowMs, organizationId);
      const request = await this.db.get(
        'SELECT * FROM agent_action_requests WHERE id=? AND organization_id=? AND run_id=?',
        requestId,
        organizationId,
        String(run['id']),
      );
      if (!request) throw new ExecutionError(404, 'ACTION_REQUEST_NOT_FOUND');
      if (request['step_id'] !== stepId)
        throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
      const handler = controlPlaneAction(String(request['action']));
      if (!handler) throw new ExecutionError(409, 'ACTION_NOT_EXECUTABLE');
      const existing = await this.db.get(
        'SELECT * FROM agent_action_executions WHERE request_id=? AND organization_id=?',
        requestId,
        organizationId,
      );
      if (existing) {
        if (existing['status'] === 'DISPATCHING')
          throw new ExecutionError(409, 'ACTION_EXECUTION_IN_PROGRESS');
        return { kind: 'done', execution: this.storedExecution(existing) };
      }
      const nowIso = new Date(nowMs).toISOString();
      const refuse = async (code: string, message: string): Promise<ExecutionPlan> => {
        await this.db.run(
          `INSERT INTO agent_action_executions (request_id, organization_id, run_id, status, error_code, started_at, completed_at)
           VALUES (?,?,?,'FAILED',?,?,?)`,
          requestId,
          organizationId,
          String(run['id']),
          code,
          nowIso,
          nowIso,
        );
        await this.deps.audit(
          String(run['agent_id']),
          'action.execution.refused',
          'agent_run',
          String(run['id']),
          { action: handler.action, requestId, code },
          organizationId,
        );
        return {
          kind: 'done',
          execution: { requestId, status: 'FAILED', error: { code, message } },
        };
      };
      const decision = String(request['decision']);
      if (decision === 'DENIED') return refuse('ACTION_DENIED', 'The action was denied.');
      if (decision === 'APPROVAL_REQUIRED') {
        const approval = await this.db.get<{ status: string; expires_at: string | null }>(
          'SELECT status, expires_at FROM approvals WHERE id=? AND organization_id=?',
          String(request['approval_id']),
          organizationId,
        );
        if (
          approval?.status === 'EXPIRED' ||
          (approval?.expires_at && approval.expires_at <= nowIso)
        )
          return refuse('APPROVAL_EXPIRED', 'The approval expired before execution.');
        if (approval?.status !== 'APPROVED')
          return refuse('APPROVAL_NOT_GRANTED', 'The action has not been approved.');
      }
      const parameters = request['parameters']
        ? (JSON.parse(String(request['parameters'])) as Record<string, unknown>)
        : null;
      // Policy, overrides, manifest, connection and scope may have changed since the decision.
      const current = await this.assess(run, {
        action: String(request['action']),
        toolId: String(request['tool_id']),
        parameters: parameters ?? undefined,
      });
      if (current.outcome === 'DENY') return refuse('POLICY_DENIED', current.reason);
      if (current.outcome === 'REQUIRE_APPROVAL' && decision === 'ALLOWED')
        return refuse(
          'APPROVAL_REQUIRED',
          'Policy now requires approval; request the action again.',
        );
      const connection = current.connection;
      if (!connection || !current.parameters)
        return refuse('CONNECTOR_NOT_CONFIGURED', 'No active connection for this action.');
      const approvedChanges = request['change_set']
        ? (JSON.parse(String(request['change_set'])) as ChangeSet)
        : null;
      // A pull request publishes exactly the approved change set; later writes need a new request.
      if ((approvedChanges?.digest ?? null) !== (current.changes?.digest ?? null))
        return refuse('CHANGE_SET_CHANGED', 'The workspace changed after the decision.');
      let secret: string;
      try {
        secret = (await this.deps.secrets.resolve(organizationId, connection.secretRef)).reveal();
      } catch (error) {
        if (!(error instanceof SecretUnavailable)) throw error;
        return refuse('SECRET_UNRESOLVED', 'The connection credential is unavailable.');
      }
      await this.db.run(
        `INSERT INTO agent_action_executions (request_id, organization_id, run_id, connection_id, status, started_at)
         VALUES (?,?,?,?,'DISPATCHING',?)`,
        requestId,
        organizationId,
        String(run['id']),
        connection.id,
        nowIso,
      );
      return {
        kind: 'dispatch',
        dispatch: {
          requestId,
          organizationId,
          runId: String(run['id']),
          agentId: String(run['agent_id']),
          action: handler.action,
          handler,
          parameters: current.parameters,
          connection,
          secret,
          changes: approvedChanges,
        },
      };
    });
  }

  /** Second half: the connector call, outside any database transaction. */
  async dispatch(pending: PendingDispatch): Promise<RuntimeActionExecution> {
    try {
      const result = await pending.handler.dispatch(
        {
          baseUrl: pending.connection.baseUrl,
          settings: pending.connection.settings,
          secret: pending.secret,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          signal: AbortSignal.timeout(this.deps.dispatchTimeoutMs ?? 30_000),
        },
        pending.parameters as never,
        pending.changes,
      );
      return { requestId: pending.requestId, status: 'SUCCEEDED', result };
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : 'CONNECTOR_FAILED';
      const status =
        error instanceof ConnectorError && error.status ? ` (HTTP ${error.status})` : '';
      return {
        requestId: pending.requestId,
        status: 'FAILED',
        error: { code, message: `The ${pending.connection.provider} connector failed${status}.` },
      };
    }
  }

  /** Record the outcome of a dispatch (caller's transaction). */
  completeExecution(
    pending: PendingDispatch,
    outcome: RuntimeActionExecution,
  ): Promise<RuntimeActionExecution> {
    return this.db.tenant(pending.organizationId, async () => {
      await this.db.run(
        `UPDATE agent_action_executions SET status=?, result=?, error_code=?, completed_at=?
         WHERE request_id=? AND organization_id=?`,
        outcome.status,
        outcome.result ? JSON.stringify(outcome.result) : null,
        outcome.error?.code ?? null,
        new Date().toISOString(),
        pending.requestId,
        pending.organizationId,
      );
      await this.deps.audit(
        pending.agentId,
        outcome.status === 'SUCCEEDED' ? 'action.executed' : 'action.execution.failed',
        'agent_run',
        pending.runId,
        {
          action: pending.action,
          requestId: pending.requestId,
          connectionId: pending.connection.id,
          ...(outcome.result
            ? { result: pending.handler.auditResult?.(outcome.result) ?? outcome.result }
            : {}),
          ...(outcome.error ? { code: outcome.error.code } : {}),
        },
        pending.organizationId,
      );
      return outcome;
    });
  }

  /**
   * Issue the single signed grant that lets an execution runtime perform one allowed or
   * approved operation (caller's transaction; run and step already checked RUNNING). The
   * grant re-authorizes against current policy and is bound to the stored operation.
   */
  issueGrant(
    run: Row,
    requestId: string,
    correlation: ExecutionGrantPayload['correlation'],
    runtimeId: string,
    nowMs = Date.now(),
  ): Promise<SignedExecutionGrant> {
    const organizationId = String(run['organization_id']);
    return this.db.tenant(organizationId, async () => {
      await this.expireDue(nowMs, organizationId);
      const request = await this.db.get(
        'SELECT * FROM agent_action_requests WHERE id=? AND organization_id=? AND run_id=?',
        requestId,
        organizationId,
        String(run['id']),
      );
      if (!request) throw new ExecutionError(404, 'ACTION_REQUEST_NOT_FOUND');
      if (request['step_id'] !== correlation.stepId)
        throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
      if (!executionAction(String(request['action'])))
        throw new ExecutionError(409, 'ACTION_NOT_GRANTABLE');
      const nowIso = new Date(nowMs).toISOString();
      const existing = await this.db.get<{ signed_grant: string; expires_at: string }>(
        'SELECT signed_grant, expires_at FROM agent_execution_grants WHERE request_id=? AND organization_id=?',
        requestId,
        organizationId,
      );
      if (existing) {
        // One grant per request: redelivery is safe because execution runtimes use it once.
        if (existing.expires_at <= nowIso) throw new ExecutionError(409, 'GRANT_EXPIRED');
        return JSON.parse(existing.signed_grant) as SignedExecutionGrant;
      }
      const refuse = async (code: string, status = 403) => {
        await this.deps.audit(
          String(run['agent_id']),
          'action.grant.refused',
          'agent_run',
          String(run['id']),
          { action: String(request['action']), requestId, code },
          organizationId,
        );
        return new ExecutionError(status, code);
      };
      const decision = String(request['decision']);
      let expiresAt = new Date(nowMs + 10 * 60_000).toISOString();
      if (decision === 'DENIED') throw await refuse('ACTION_DENIED');
      if (decision === 'APPROVAL_REQUIRED') {
        const approval = await this.db.get<{ status: string; expires_at: string | null }>(
          'SELECT status, expires_at FROM approvals WHERE id=? AND organization_id=?',
          String(request['approval_id']),
          organizationId,
        );
        if (
          approval?.status === 'EXPIRED' ||
          (approval?.expires_at && approval.expires_at <= nowIso)
        )
          throw await refuse('APPROVAL_EXPIRED');
        if (approval?.status !== 'APPROVED') throw await refuse('APPROVAL_NOT_GRANTED');
        if (approval.expires_at && approval.expires_at < expiresAt) expiresAt = approval.expires_at;
      }
      const parameters = request['parameters']
        ? (JSON.parse(String(request['parameters'])) as Record<string, unknown>)
        : undefined;
      const current = await this.assess(run, {
        action: String(request['action']),
        toolId: String(request['tool_id']),
        parameters,
      });
      if (current.outcome === 'DENY') throw await refuse('POLICY_DENIED');
      if (current.outcome === 'REQUIRE_APPROVAL' && decision === 'ALLOWED')
        throw await refuse('APPROVAL_REQUIRED', 409);
      if (!current.execution || !current.parameters) throw await refuse('PARAMETERS_REQUIRED', 409);
      const hosts = current.execution.policy.hosts(current.execution.operation);
      const grantId = randomUUID();
      const operation = current.execution.operation;
      const operationDigest = digest(current.parameters);
      // A checkout of a repository an active source-control connection allows is authenticated
      // with a single-use credential lease bound to this grant; any other is anonymous.
      const credential =
        operation.kind === 'git.checkout' && this.deps.credentials
          ? await this.deps.credentials.leaseForCheckout({
              run,
              requestId,
              grantId,
              operation,
              operationDigest,
              runtimeId,
              grantExpiresAt: expiresAt,
              nowMs,
            })
          : null;
      const grant = this.deps.signGrant({
        kind: EXECUTION_GRANT_KIND,
        grantId,
        requestId,
        action: String(request['action']),
        correlation,
        operationKind: operation.kind,
        operationDigest,
        isolation: current.execution.isolation,
        limits: {
          timeoutMs: Math.max(1000, Math.min(current.execution.timeoutMs, 3_600_000)),
          cpuMillis: 2000,
          memoryMb: 2048,
          maxProcesses: current.execution.policy.maxProcesses ?? DEFAULT_MAX_PROCESSES,
          network: hosts.length
            ? { mode: 'ALLOW_LIST', allowedHosts: hosts }
            : { mode: 'NONE', allowedHosts: [] },
        },
        ...(credential ? { credential } : {}),
        issuedAt: nowIso,
        expiresAt,
      });
      await this.db.run(
        `INSERT INTO agent_execution_grants (grant_id, request_id, organization_id, run_id, operation_kind,
         signed_grant, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`,
        grant.payload.grantId,
        requestId,
        organizationId,
        String(run['id']),
        grant.payload.operationKind,
        JSON.stringify(grant),
        nowIso,
        expiresAt,
      );
      await this.deps.audit(
        String(run['agent_id']),
        'action.grant.issued',
        'agent_run',
        String(run['id']),
        {
          action: grant.payload.action,
          requestId,
          grantId: grant.payload.grantId,
          operationKind: grant.payload.operationKind,
          expiresAt,
          ...(credential ? { credentialLeaseId: credential.leaseId } : {}),
        },
        organizationId,
      );
      return grant;
    });
  }

  /**
   * Expire pending approvals past their deadline and cancel the runs they paused. Called
   * lazily wherever approvals are read, decided or executed, so no scheduler is required.
   * With an organization it sweeps that tenant only; without one (runtime claims) it sweeps
   * every organization in the platform scope.
   */
  expireDue(nowMs = Date.now(), organizationId?: string): Promise<number> {
    const nowIso = new Date(nowMs).toISOString();
    const sweep = async () => {
      const due = await this.db.all<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM approvals WHERE status='PENDING' AND expires_at IS NOT NULL AND expires_at<=?
         ${organizationId ? 'AND organization_id=?' : ''} ORDER BY expires_at, seq`,
        nowIso,
        ...(organizationId ? [organizationId] : []),
      );
      for (const approval of due) {
        await this.db.run(
          `UPDATE approvals SET status='EXPIRED' WHERE id=? AND organization_id=? AND status='PENDING'`,
          approval.id,
          approval.organization_id,
        );
        await this.execution.onApprovalExpired(approval.organization_id, approval.id);
        await this.deps.audit(
          'platform',
          'approval.expired',
          'approval',
          approval.id,
          {},
          approval.organization_id,
        );
      }
      return due.length;
    };
    return organizationId ? this.db.tenant(organizationId, sweep) : this.db.platform(sweep);
  }

  private async assess(
    run: Row,
    request: {
      action: string;
      toolId: string;
      toolVersion?: string;
      parameters?: Record<string, unknown> | undefined;
      inputDigest?: string;
    },
  ): Promise<Assessment> {
    const deny = (reason: string, risk: ApprovalRisk = 'CRITICAL'): Assessment => ({
      outcome: 'DENY',
      risk,
      reason,
      policy: null,
      handler: null,
      parameters: null,
      connection: null,
      summary: null,
      resource: null,
      changes: null,
      execution: null,
    });
    const organizationId = String(run['organization_id']);
    let manifest: AnySignedAgentManifest;
    try {
      manifest = await this.deps.loadManifest(
        String(run['agent_id']),
        organizationId,
        String(run['employee_id']),
      );
    } catch (error) {
      // Database failures are not verdicts: the transaction is aborted, so fail the request.
      if ((error as { code?: unknown }).code !== undefined) throw error;
      return deny('MANIFEST_INVALID');
    }
    const payload = manifest.payload;
    if (
      payload.apiVersion !== 'agents-foundry/v2' ||
      payload.metadata.manifestId !== run['manifest_id']
    )
      return deny('MANIFEST_INVALID');
    if (!payload.tools.includes(request.toolId)) return deny('TOOL_NOT_IN_MANIFEST');
    let bundle: ResolvedBlueprintBundle;
    try {
      bundle = await this.deps.bundle(
        payload.metadata.blueprint.id,
        payload.metadata.blueprint.version,
      );
    } catch {
      return deny('BLUEPRINT_UNAVAILABLE');
    }
    if (!payload.metadata.blueprint.digest || bundle.digest !== payload.metadata.blueprint.digest)
      return deny('BLUEPRINT_DIGEST_MISMATCH');
    const tool = bundle.tools.find((candidate) => candidate.id === request.toolId);
    if (!tool || (request.toolVersion !== undefined && tool.version !== request.toolVersion))
      return deny('TOOL_VERSION_MISMATCH');
    if (!tool.governedActions.includes(request.action)) return deny('ACTION_NOT_GOVERNED_BY_TOOL');
    const capability = payload.policies.capabilities.find(
      (candidate) => candidate.action === request.action,
    );
    if (!capability) return deny('ACTION_NOT_IN_MANIFEST');

    const handler = controlPlaneAction(request.action) ?? null;
    let parameters: Record<string, unknown> | null = null;
    let connection: ConnectorConnection | null = null;
    let resource: { type: string; id: string; inScope: boolean } | undefined;
    let changes: ChangeSet | null = null;
    if (handler) {
      if (!request.parameters) return deny('PARAMETERS_REQUIRED');
      const parsed = handler.parameters.safeParse(request.parameters);
      if (!parsed.success) return deny('PARAMETERS_INVALID');
      if (request.inputDigest !== undefined && digest(request.parameters) !== request.inputDigest)
        return deny('INPUT_DIGEST_MISMATCH');
      parameters = request.parameters;
      connection = await this.deps.connectors.active(organizationId, handler.connectorProvider);
      if (!connection) return deny('CONNECTOR_NOT_CONFIGURED');
      const granted = payload.connectors.some(
        (connector) =>
          connector.id === handler.connectorProvider &&
          connector.capabilities.includes(handler.requiredCapability),
      );
      if (!granted) return deny('CONNECTOR_CAPABILITY_MISSING');
      resource = {
        ...handler.resource(parameters as never),
        inScope: handler.inScope(parameters as never, connection.settings, payload.configuration),
      };
      if (handler.changeSetDirectory) {
        const resolved = await this.changeSet(run, handler.changeSetDirectory(parameters as never));
        if (typeof resolved === 'string') return deny(resolved);
        changes = resolved;
      }
    }
    const executionPolicy = handler ? undefined : executionAction(request.action);
    let execution: Assessment['execution'] = null;
    if (executionPolicy) {
      if (!request.parameters) return deny('PARAMETERS_REQUIRED');
      let operation: ExecutionOperation;
      try {
        operation = parseExecutionOperation(request.parameters);
      } catch {
        return deny('PARAMETERS_INVALID');
      }
      if (!executionPolicy.operations.includes(operation.kind))
        return deny('OPERATION_NOT_ALLOWED');
      if (request.inputDigest !== undefined && digest(request.parameters) !== request.inputDigest)
        return deny('INPUT_DIGEST_MISMATCH');
      parameters = request.parameters;
      resource = {
        ...executionPolicy.resource(operation),
        inScope: executionPolicy.inScope(operation, payload.configuration),
      };
      execution = {
        policy: executionPolicy,
        operation,
        isolation: payload.runtime.isolation,
        timeoutMs: tool.timeoutMs,
      };
    }
    // Read before evaluating: a database failure aborts the transaction and fails the request.
    const organizationOutcome = await this.deps.policies.outcome(organizationId, request.action);
    let policy: ActionPolicyDecision;
    try {
      policy = this.evaluate({
        action: request.action,
        organizationId,
        actor: {
          kind: 'AGENT',
          agentId: String(run['agent_id']),
          employeeId: String(run['employee_id']),
        },
        manifestOutcome: capability.outcome,
        organizationOutcome,
        ...(resource ? { resource } : {}),
      });
    } catch {
      return deny('POLICY_UNAVAILABLE');
    }
    return {
      outcome: policy.outcome,
      risk: policy.risk,
      reason: policy.reason,
      policy,
      handler,
      parameters,
      connection,
      summary:
        handler && parameters
          ? handler.summary(parameters as never, changes)
          : execution
            ? execution.policy.summary(execution.operation).slice(0, 500)
            : null,
      resource: resource ? { type: resource.type, id: resource.id } : null,
      changes,
      execution,
    };
  }

  /**
   * The thread's workspace changes under `directory`: the latest content of every file written
   * by a `repository.write` operation that was granted and whose step completed, with paths made
   * relative to `directory`. Recorded by the control plane, never supplied by the runtime.
   */
  private async changeSet(run: Row, directory: string): Promise<ChangeSet | string> {
    const rows = await this.db.all<{ parameters: string }>(
      `SELECT r.parameters FROM agent_action_requests r
       JOIN agent_runs ru ON ru.id=r.run_id AND ru.organization_id=r.organization_id
       JOIN agent_run_steps s ON s.id=r.step_id AND s.status='COMPLETED'
       JOIN agent_execution_grants g ON g.request_id=r.id
       WHERE r.organization_id=? AND ru.thread_id=? AND r.action='repository.write'
       AND r.parameters IS NOT NULL ORDER BY r.created_at, r.seq`,
      String(run['organization_id']),
      String(run['thread_id']),
    );
    const latest = new Map<string, string>();
    for (const row of rows) {
      const operation = JSON.parse(row.parameters) as {
        kind?: string;
        path?: string;
        content?: string;
      };
      if (operation.kind !== 'file.write' || typeof operation.content !== 'string') continue;
      if (!operation.path?.startsWith(`${directory}/`)) continue;
      latest.set(operation.path.slice(directory.length + 1), operation.content);
    }
    const files = [...latest.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => ({ path, content }));
    if (!files.length) return 'CHANGE_SET_EMPTY';
    const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    if (files.length > MAX_CHANGE_SET_FILES || bytes > MAX_CHANGE_SET_BYTES)
      return 'CHANGE_SET_TOO_LARGE';
    return { digest: digest(files), files };
  }

  private storedExecution(row: Row): RuntimeActionExecution {
    const status = String(row['status']) === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
    return {
      requestId: String(row['request_id']),
      status,
      ...(row['result']
        ? { result: JSON.parse(String(row['result'])) as Record<string, string> }
        : {}),
      ...(status === 'FAILED'
        ? {
            error: {
              code: String(row['error_code'] ?? 'ACTION_FAILED'),
              message: 'The action did not succeed.',
            },
          }
        : {}),
    };
  }
}
