import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
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
import { controlPlaneAction, type ControlPlaneAction } from './action-registry.js';
import { executionAction, type ExecutionAction } from './execution-actions.js';
import { parseExecutionOperation } from '../../../../packages/contracts/src/execution-runtime/v1/schemas.js';
import type { ActionPolicyService } from './action-policy-service.js';
import { ConnectorError } from './connectors/jira.js';
import type { ConnectorService } from './connector-service.js';
import type { SecretResolver } from './secrets.js';

type Row = Record<string, SQLInputValue>;
type Audit = (
  actorId: string,
  eventType: string,
  resourceType: string,
  resourceId: string,
  metadata: object,
  organizationId: string,
) => void;

export interface ActionGatewayDependencies {
  loadManifest: (
    agentId: string,
    organizationId: string,
    employeeId: string,
  ) => AnySignedAgentManifest;
  bundle: (blueprintId: string, version: string) => ResolvedBlueprintBundle;
  audit: Audit;
  connectors: ConnectorService;
  policies: ActionPolicyService;
  secrets: SecretResolver;
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
}

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
    private readonly db: DatabaseSync,
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
  ): RuntimeActionDecision {
    const organizationId = String(run['organization_id']);
    const verdict = this.assess(run, request);
    const now = new Date();
    const approvalId = verdict.outcome === 'REQUIRE_APPROVAL' ? randomUUID() : null;
    const summary = verdict.summary ?? request.summary;
    if (approvalId) {
      const ttl = verdict.policy?.conditions.find(
        (condition) => condition.type === 'APPROVAL_TTL_SECONDS',
      );
      const expiresAt = new Date(now.getTime() + (ttl ? ttl.value : 3600) * 1000).toISOString();
      const resource = verdict.resource;
      this.db
        .prepare(
          `INSERT INTO approvals (id, organization_id, requested_by, action, resource_type, resource_id,
           risk, summary, status, created_at, run_id, step_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
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
      this.execution.pauseForApproval(
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
    this.db
      .prepare(
        `INSERT INTO agent_action_requests (id, organization_id, run_id, step_id, runtime_id, action, tool_id,
         request_hash, decision, risk, reason, approval_id, created_at, parameters, policy_id, policy_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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
      );
    this.deps.audit(
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
      this.db
        .prepare('SELECT * FROM agent_action_requests WHERE id=?')
        .get(request.requestId) as Row,
    );
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
  prepareExecution(run: Row, requestId: string, stepId: string, nowMs = Date.now()): ExecutionPlan {
    this.expireDue(nowMs);
    const organizationId = String(run['organization_id']);
    const request = this.db
      .prepare('SELECT * FROM agent_action_requests WHERE id=? AND organization_id=? AND run_id=?')
      .get(requestId, organizationId, run['id']) as Row | undefined;
    if (!request) throw new ExecutionError(404, 'ACTION_REQUEST_NOT_FOUND');
    if (request['step_id'] !== stepId)
      throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
    const handler = controlPlaneAction(String(request['action']));
    if (!handler) throw new ExecutionError(409, 'ACTION_NOT_EXECUTABLE');
    const existing = this.db
      .prepare('SELECT * FROM agent_action_executions WHERE request_id=?')
      .get(requestId) as Row | undefined;
    if (existing) {
      if (existing['status'] === 'DISPATCHING')
        throw new ExecutionError(409, 'ACTION_EXECUTION_IN_PROGRESS');
      return { kind: 'done', execution: this.storedExecution(existing) };
    }
    const nowIso = new Date(nowMs).toISOString();
    const refuse = (code: string, message: string): ExecutionPlan => {
      this.db
        .prepare(
          `INSERT INTO agent_action_executions (request_id, organization_id, run_id, status, error_code, started_at, completed_at)
           VALUES (?,?,?,'FAILED',?,?,?)`,
        )
        .run(requestId, organizationId, String(run['id']), code, nowIso, nowIso);
      this.deps.audit(
        String(run['agent_id']),
        'action.execution.refused',
        'agent_run',
        String(run['id']),
        { action: handler.action, requestId, code },
        organizationId,
      );
      return { kind: 'done', execution: { requestId, status: 'FAILED', error: { code, message } } };
    };
    const decision = String(request['decision']);
    if (decision === 'DENIED') return refuse('ACTION_DENIED', 'The action was denied.');
    if (decision === 'APPROVAL_REQUIRED') {
      const approval = this.db
        .prepare('SELECT status, expires_at FROM approvals WHERE id=? AND organization_id=?')
        .get(request['approval_id'], organizationId) as
        { status: string; expires_at: string | null } | undefined;
      if (approval?.status === 'EXPIRED' || (approval?.expires_at && approval.expires_at <= nowIso))
        return refuse('APPROVAL_EXPIRED', 'The approval expired before execution.');
      if (approval?.status !== 'APPROVED')
        return refuse('APPROVAL_NOT_GRANTED', 'The action has not been approved.');
    }
    const parameters = request['parameters']
      ? (JSON.parse(String(request['parameters'])) as Record<string, unknown>)
      : null;
    // Policy, overrides, manifest, connection and scope may have changed since the decision.
    const current = this.assess(run, {
      action: String(request['action']),
      toolId: String(request['tool_id']),
      parameters: parameters ?? undefined,
    });
    if (current.outcome === 'DENY') return refuse('POLICY_DENIED', current.reason);
    if (current.outcome === 'REQUIRE_APPROVAL' && decision === 'ALLOWED')
      return refuse('APPROVAL_REQUIRED', 'Policy now requires approval; request the action again.');
    const connection = current.connection;
    if (!connection || !current.parameters)
      return refuse('CONNECTOR_NOT_CONFIGURED', 'No active connection for this action.');
    const secret = this.deps.secrets.resolve(organizationId, connection.secretRef);
    if (!secret) return refuse('SECRET_UNRESOLVED', 'The connection credential is unavailable.');
    this.db
      .prepare(
        `INSERT INTO agent_action_executions (request_id, organization_id, run_id, connection_id, status, started_at)
         VALUES (?,?,?,?,'DISPATCHING',?)`,
      )
      .run(requestId, organizationId, String(run['id']), connection.id, nowIso);
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
      },
    };
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
  ): RuntimeActionExecution {
    this.db
      .prepare(
        `UPDATE agent_action_executions SET status=?, result=?, error_code=?, completed_at=? WHERE request_id=?`,
      )
      .run(
        outcome.status,
        outcome.result ? JSON.stringify(outcome.result) : null,
        outcome.error?.code ?? null,
        new Date().toISOString(),
        pending.requestId,
      );
    this.deps.audit(
      pending.agentId,
      outcome.status === 'SUCCEEDED' ? 'action.executed' : 'action.execution.failed',
      'agent_run',
      pending.runId,
      {
        action: pending.action,
        requestId: pending.requestId,
        connectionId: pending.connection.id,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.error ? { code: outcome.error.code } : {}),
      },
      pending.organizationId,
    );
    return outcome;
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
    nowMs = Date.now(),
  ): SignedExecutionGrant {
    this.expireDue(nowMs);
    const organizationId = String(run['organization_id']);
    const request = this.db
      .prepare('SELECT * FROM agent_action_requests WHERE id=? AND organization_id=? AND run_id=?')
      .get(requestId, organizationId, run['id']) as Row | undefined;
    if (!request) throw new ExecutionError(404, 'ACTION_REQUEST_NOT_FOUND');
    if (request['step_id'] !== correlation.stepId)
      throw new ExecutionError(409, 'RUNTIME_CORRELATION_MISMATCH');
    if (!executionAction(String(request['action'])))
      throw new ExecutionError(409, 'ACTION_NOT_GRANTABLE');
    const nowIso = new Date(nowMs).toISOString();
    const existing = this.db
      .prepare('SELECT signed_grant, expires_at FROM agent_execution_grants WHERE request_id=?')
      .get(requestId) as { signed_grant: string; expires_at: string } | undefined;
    if (existing) {
      // One grant per request: redelivery is safe because execution runtimes use it once.
      if (existing.expires_at <= nowIso) throw new ExecutionError(409, 'GRANT_EXPIRED');
      return JSON.parse(existing.signed_grant) as SignedExecutionGrant;
    }
    const refuse = (code: string, status = 403) => {
      this.deps.audit(
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
    if (decision === 'DENIED') throw refuse('ACTION_DENIED');
    if (decision === 'APPROVAL_REQUIRED') {
      const approval = this.db
        .prepare('SELECT status, expires_at FROM approvals WHERE id=? AND organization_id=?')
        .get(request['approval_id'], organizationId) as
        { status: string; expires_at: string | null } | undefined;
      if (approval?.status === 'EXPIRED' || (approval?.expires_at && approval.expires_at <= nowIso))
        throw refuse('APPROVAL_EXPIRED');
      if (approval?.status !== 'APPROVED') throw refuse('APPROVAL_NOT_GRANTED');
      if (approval.expires_at && approval.expires_at < expiresAt) expiresAt = approval.expires_at;
    }
    const parameters = request['parameters']
      ? (JSON.parse(String(request['parameters'])) as Record<string, unknown>)
      : undefined;
    const current = this.assess(run, {
      action: String(request['action']),
      toolId: String(request['tool_id']),
      parameters,
    });
    if (current.outcome === 'DENY') throw refuse('POLICY_DENIED');
    if (current.outcome === 'REQUIRE_APPROVAL' && decision === 'ALLOWED')
      throw refuse('APPROVAL_REQUIRED', 409);
    if (!current.execution || !current.parameters) throw refuse('PARAMETERS_REQUIRED', 409);
    const hosts = current.execution.policy.hosts(current.execution.operation);
    const grant = this.deps.signGrant({
      kind: EXECUTION_GRANT_KIND,
      grantId: randomUUID(),
      requestId,
      action: String(request['action']),
      correlation,
      operationKind: current.execution.operation.kind,
      operationDigest: digest(current.parameters),
      isolation: current.execution.isolation,
      limits: {
        timeoutMs: Math.max(1000, Math.min(current.execution.timeoutMs, 3_600_000)),
        cpuMillis: 2000,
        memoryMb: 2048,
        maxProcesses: 64,
        network: hosts.length
          ? { mode: 'ALLOW_LIST', allowedHosts: hosts }
          : { mode: 'NONE', allowedHosts: [] },
      },
      issuedAt: nowIso,
      expiresAt,
    });
    this.db
      .prepare(
        `INSERT INTO agent_execution_grants (grant_id, request_id, organization_id, run_id, operation_kind,
         signed_grant, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        grant.payload.grantId,
        requestId,
        organizationId,
        String(run['id']),
        grant.payload.operationKind,
        JSON.stringify(grant),
        nowIso,
        expiresAt,
      );
    this.deps.audit(
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
      },
      organizationId,
    );
    return grant;
  }

  /**
   * Expire pending approvals past their deadline and cancel the runs they paused. Called
   * lazily wherever approvals are read, decided or executed, so no scheduler is required.
   */
  expireDue(nowMs = Date.now()): number {
    const nowIso = new Date(nowMs).toISOString();
    const due = this.db
      .prepare(
        `SELECT id, organization_id FROM approvals WHERE status='PENDING' AND expires_at IS NOT NULL AND expires_at<=?`,
      )
      .all(nowIso) as { id: string; organization_id: string }[];
    if (!due.length) return 0;
    this.transaction(() => {
      for (const approval of due) {
        this.db
          .prepare(`UPDATE approvals SET status='EXPIRED' WHERE id=? AND status='PENDING'`)
          .run(approval.id);
        this.execution.onApprovalExpired(approval.organization_id, approval.id);
        this.deps.audit(
          'platform',
          'approval.expired',
          'approval',
          approval.id,
          {},
          approval.organization_id,
        );
      }
    });
    return due.length;
  }

  private assess(
    run: Row,
    request: {
      action: string;
      toolId: string;
      toolVersion?: string;
      parameters?: Record<string, unknown> | undefined;
      inputDigest?: string;
    },
  ): Assessment {
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
      execution: null,
    });
    const organizationId = String(run['organization_id']);
    let manifest: AnySignedAgentManifest;
    try {
      manifest = this.deps.loadManifest(
        String(run['agent_id']),
        organizationId,
        String(run['employee_id']),
      );
    } catch {
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
      bundle = this.deps.bundle(payload.metadata.blueprint.id, payload.metadata.blueprint.version);
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
    if (handler) {
      if (!request.parameters) return deny('PARAMETERS_REQUIRED');
      const parsed = handler.parameters.safeParse(request.parameters);
      if (!parsed.success) return deny('PARAMETERS_INVALID');
      if (request.inputDigest !== undefined && digest(request.parameters) !== request.inputDigest)
        return deny('INPUT_DIGEST_MISMATCH');
      parameters = request.parameters;
      connection = this.deps.connectors.active(organizationId, handler.connectorProvider);
      if (!connection) return deny('CONNECTOR_NOT_CONFIGURED');
      const granted = payload.connectors.some(
        (connector) =>
          connector.id === handler.connectorProvider &&
          connector.capabilities.includes(handler.requiredCapability),
      );
      if (!granted) return deny('CONNECTOR_CAPABILITY_MISSING');
      resource = {
        ...handler.resource(parameters as never),
        inScope: handler.inScope(parameters as never, connection.settings),
      };
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
        organizationOutcome: this.deps.policies.outcome(organizationId, request.action),
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
          ? handler.summary(parameters as never)
          : execution
            ? execution.policy.summary(execution.operation).slice(0, 500)
            : null,
      resource: resource ? { type: resource.type, id: resource.id } : null,
      execution,
    };
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

  private transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
