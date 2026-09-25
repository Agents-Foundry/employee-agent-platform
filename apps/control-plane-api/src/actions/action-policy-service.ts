import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  Actor,
  GovernedActionSummary,
  OrganizationActionPolicy,
  OrganizationPolicyOutcome,
} from '@agents-foundry/contracts';
import {
  evaluatePolicy,
  isKnownAction,
  knownActions,
} from '../../../../packages/policy-engine/src/index.js';
import {
  OrganizationDomainError,
  type OrganizationStructureService,
} from '../organization/structure-service.js';
import { controlPlaneAction } from './action-registry.js';

type Audit = (
  actorId: string,
  eventType: string,
  resourceType: string,
  resourceId: string,
  metadata: object,
  organizationId: string,
) => void;

const overrideSchema = z
  .object({
    // ALLOW is deliberately absent: organizations can only tighten platform policy.
    outcome: z.enum(['REQUIRE_APPROVAL', 'DENY']),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** Organization-level, tighten-only overrides of governed-action policy (ADR 0012). */
export class ActionPolicyService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly structure: OrganizationStructureService,
    private readonly audit: Audit,
  ) {}

  list(actor: Actor): GovernedActionSummary[] {
    this.structure.authorize(actor);
    const overrides = new Map(
      this.overrides(actor.organizationId).map((policy) => [policy.action, policy]),
    );
    return knownActions()
      .sort()
      .map((action) => {
        const base = evaluatePolicy(action);
        const handler = controlPlaneAction(action);
        return {
          action,
          defaultOutcome: base.outcome,
          risk: base.risk,
          executedBy: handler ? 'CONTROL_PLANE' : 'RUNTIME',
          connectorProvider: handler?.connectorProvider ?? null,
          override: overrides.get(action) ?? null,
        };
      });
  }

  set(actor: Actor, action: string, raw: unknown): OrganizationActionPolicy {
    const input = overrideSchema.parse(raw);
    this.structure.authorize(actor);
    if (!isKnownAction(action)) throw new OrganizationDomainError(404, 'ACTION_UNKNOWN');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO organization_action_policies (organization_id,action,outcome,reason,updated_by,updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(organization_id,action) DO UPDATE SET
         outcome=excluded.outcome, reason=excluded.reason, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(actor.organizationId, action, input.outcome, input.reason, actor.id, now);
    this.audit(
      actor.id,
      'action_policy.set',
      'action_policy',
      action,
      { outcome: input.outcome },
      actor.organizationId,
    );
    return this.overrides(actor.organizationId).find((policy) => policy.action === action)!;
  }

  clear(actor: Actor, action: string): void {
    this.structure.authorize(actor);
    const removed = this.db
      .prepare('DELETE FROM organization_action_policies WHERE organization_id=? AND action=?')
      .run(actor.organizationId, action);
    if (removed.changes !== 1) throw new OrganizationDomainError(404, 'ACTION_POLICY_NOT_FOUND');
    this.audit(
      actor.id,
      'action_policy.cleared',
      'action_policy',
      action,
      {},
      actor.organizationId,
    );
  }

  /** The tenant's override for an action, or null when the platform default applies. */
  outcome(organizationId: string, action: string): OrganizationPolicyOutcome | null {
    const row = this.db
      .prepare(
        'SELECT outcome FROM organization_action_policies WHERE organization_id=? AND action=?',
      )
      .get(organizationId, action) as { outcome: OrganizationPolicyOutcome } | undefined;
    return row?.outcome ?? null;
  }

  private overrides(organizationId: string): OrganizationActionPolicy[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM organization_action_policies WHERE organization_id=? ORDER BY action',
        )
        .all(organizationId) as Record<string, unknown>[]
    ).map((row) => ({
      organizationId: String(row['organization_id']),
      action: String(row['action']),
      outcome: String(row['outcome']) as OrganizationPolicyOutcome,
      reason: String(row['reason']),
      updatedBy: String(row['updated_by']),
      updatedAt: String(row['updated_at']),
    }));
  }
}
