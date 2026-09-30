import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { LOCAL_ISSUER, type NewMember } from './onboarding-types.js';
import type {
  AgentDefinition,
  Approval,
  ApprovalStatus,
  BootstrapResponse,
  Conversation,
  ConversationDetail,
  ConversationMessage,
  Employee,
  Organization,
  QaRun,
  QaRunStatus,
  AgentRunStatus,
  ProvisioningInput,
  ProvisioningRequest,
  AnySignedAgentManifest,
  ResolvedBlueprintBundle,
  WorkflowDefinition,
  GenericQaRunResponse,
  TaskSpec,
  LifecycleEvent,
  Actor,
  AdminAgentInput,
  AgentAssignment,
  CatalogDefinitions,
} from '@agents-foundry/contracts';
import type { IdentityEntry } from './identity-directory.js';
import { ManifestSigner } from './manifest-signing.js';
import { OrganizationStructureService } from './organization/structure-service.js';
import { JobArchitectureService } from './organization/job-service.js';
import { TenancyService } from './organization/tenancy-service.js';
import type { TenantDomainCacheOptions } from './organization/tenant-domain-cache.js';
import { ExecutionService } from './execution/execution-service.js';
import { RuntimeIdentityRegistry, type RuntimeIdentityConfig } from './runtime/runtime-identity.js';
import { RuntimeTransportService } from './runtime/runtime-transport-service.js';
import { ActionGateway } from './actions/action-gateway.js';
import { ActionPolicyService } from './actions/action-policy-service.js';
import { ConnectorService } from './actions/connector-service.js';
import { FileSecretStore, type SecretResolver } from './actions/secrets.js';
import { CatalogService, agentLabel } from './catalog/catalog-service.js';
import { InstallationService } from './catalog/installation-service.js';
import { ModelSpendingService } from './spending/model-spending-service.js';
import { AlertWebhookService } from './webhooks/alert-webhook-service.js';
import { ModelQualityService } from './quality/quality-service.js';
import type { WebhookSend } from './webhooks/webhook-transport.js';
import { OrganizationDomainError } from './organization/structure-service.js';
import { builtInCatalog } from '../../../packages/catalog/src/index.js';
import { buildManifestPayload, type ManifestIssue } from './agents/manifest-v2.js';
import { manifestSubject } from '../../../packages/contracts/src/manifest.js';
import { parseSignedManifest } from '../../../packages/contracts/src/runtime/v1/schemas.js';
import { PgStore, type PgStoreConfig, type Row } from './db/pg-store.js';
import { assertSchemaCurrent, migrate } from './db/migrate.js';

const ORGANIZATION_ID = 'org_agents_foundry';
const EMPLOYEE_ID = 'employee_qa_demo';
const AGENT_ID = 'agent_qa_engineer';
const QA_WORKFLOW = 'validate-story';

function now(): string {
  return new Date().toISOString();
}

interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  destination: string;
}
const demoEmployee: Actor = { id: EMPLOYEE_ID, role: 'EMPLOYEE', organizationId: ORGANIZATION_ID };

export interface ControlPlaneDatabaseOptions {
  /** An open store; otherwise one is connected from `connection` or the environment. */
  store?: PgStore;
  connection?: PgStoreConfig & {
    /** Schema owner: when set, pending migrations are applied at startup. */
    migrationUrl?: string;
  };
  /** Seed the local demo tenant (demo mode only). */
  seedDemo?: boolean;
  /** Manifest and grant signer; defaults to the key file at MANIFEST_SIGNING_KEY_PATH. */
  signer?: ManifestSigner;
  manifestV2Issuance?: boolean;
  catalog?: CatalogDefinitions;
  genericRuntime?: boolean;
  qaGenericRuntime?: boolean;
  runtimeIdentities?: RuntimeIdentityConfig[];
  /** Connector secret store; defaults to the operator file at CONNECTOR_SECRETS_PATH. */
  secrets?: SecretResolver;
  /** Connector HTTP client (tests). */
  connectorFetch?: typeof fetch;
  /** Allow http and private hosts for connector URLs (local testing only). */
  allowPrivateConnectorUrls?: boolean;
  /** ADR 0024: deliver budget alerts to organization webhooks (`ALERT_WEBHOOKS_ENABLED`). */
  alertWebhooks?: boolean;
  /** Allow http and private hosts for alert webhooks (local testing only). */
  allowPrivateWebhookUrls?: boolean;
  /** Webhook HTTP client (tests). */
  webhookSend?: WebhookSend;
  /** ADR 0027: remembering which organization each verified host belongs to (tests). */
  domainCache?: TenantDomainCacheOptions;
}

/** PostgreSQL connection settings from the environment (ADR 0018). */
export function connectionFromEnvironment(): NonNullable<
  ControlPlaneDatabaseOptions['connection']
> {
  const tenantUrl = process.env['DATABASE_URL'];
  const platformUrl = process.env['DATABASE_PLATFORM_URL'];
  if (!tenantUrl || !platformUrl) throw new Error('DATABASE_URL_REQUIRED');
  const migrationUrl = process.env['DATABASE_MIGRATION_URL'];
  return { tenantUrl, platformUrl, ...(migrationUrl ? { migrationUrl } : {}) };
}

export class ControlPlaneDatabase {
  readonly structure: OrganizationStructureService;
  readonly jobs: JobArchitectureService;
  readonly tenancy: TenancyService;
  readonly execution: ExecutionService;
  readonly installations: InstallationService;
  /** ADR 0004: new agents receive agents-foundry/v2 manifests only when explicitly enabled. */
  readonly manifestV2Issuance: boolean;
  /** Phase C: employees may start generic runs for runtimes only when explicitly enabled. */
  readonly genericRuntimeEnabled: boolean;
  /** Phase F: `/api/qa/runs` queues generic validate-story runs for eligible agents. */
  readonly qaGenericRuntimeEnabled: boolean;
  readonly runtimeIdentities: RuntimeIdentityRegistry;
  readonly runtimeTransport: RuntimeTransportService;
  readonly modelSpending: ModelSpendingService;
  readonly alertWebhooks: AlertWebhookService;
  readonly quality: ModelQualityService;
  readonly connectors: ConnectorService;
  readonly actionPolicies: ActionPolicyService;
  readonly actions: ActionGateway;

  /**
   * Connects to PostgreSQL, checks (or applies) the schema, registers the catalog and seeds
   * the demo tenant when asked. Fails closed on an unknown or mismatched schema.
   */
  static async open(options: ControlPlaneDatabaseOptions = {}): Promise<ControlPlaneDatabase> {
    let store = options.store;
    if (!store) {
      const connection = options.connection ?? connectionFromEnvironment();
      if (connection.migrationUrl) await migrate(connection.migrationUrl);
      store = await PgStore.connect(connection);
    }
    try {
      await store.platform(() =>
        assertSchemaCurrent(() =>
          store.all<{ version: number; checksum: string }>(
            'SELECT version, checksum FROM schema_migrations ORDER BY version',
          ),
        ),
      );
      const catalog = await CatalogService.open(store, options.catalog ?? builtInCatalog);
      const signer =
        options.signer ??
        ManifestSigner.fromFile(
          process.env['MANIFEST_SIGNING_KEY_PATH'] ?? '.data/agents-foundry.db.signing-key.pem',
        );
      const database = new ControlPlaneDatabase(store, catalog, signer, options);
      if (options.seedDemo) await database.seed();
      await database.tenancy.domains.start();
      return database;
    } catch (error) {
      if (!options.store) await store.close();
      throw error;
    }
  }

  private constructor(
    readonly store: PgStore,
    readonly catalog: CatalogService,
    readonly signer: ManifestSigner,
    options: ControlPlaneDatabaseOptions,
  ) {
    const db = store;
    this.genericRuntimeEnabled =
      options.genericRuntime ?? process.env['GENERIC_AGENT_RUNTIME_ENABLED'] === 'true';
    this.qaGenericRuntimeEnabled =
      options.qaGenericRuntime ?? process.env['QA_GENERIC_RUNTIME_ENABLED'] === 'true';
    this.runtimeIdentities = options.runtimeIdentities
      ? new RuntimeIdentityRegistry(options.runtimeIdentities)
      : RuntimeIdentityRegistry.fromEnvironment();
    this.manifestV2Issuance =
      options.manifestV2Issuance ?? process.env['AGENT_MANIFEST_V2_ISSUANCE_ENABLED'] === 'true';
    this.structure = new OrganizationStructureService(db);
    this.jobs = new JobArchitectureService(db, this.structure);
    this.tenancy = new TenancyService(db, this.structure, options.domainCache);
    this.installations = new InstallationService(db, this.catalog, this.structure);
    this.execution = new ExecutionService(
      db,
      (agentId, organizationId, employeeId) =>
        this.getManifest(agentId, organizationId, employeeId),
      {
        resolveWorkflow: (manifest, workflowId) => this.pinnedWorkflow(manifest, workflowId),
        conversationMessage: async (organizationId, conversationId, content) => {
          await this.addMessage(conversationId, 'AGENT', content, organizationId);
        },
      },
    );
    const audit = (
      actorId: string,
      eventType: string,
      resourceType: string,
      resourceId: string,
      metadata: object,
      organizationId: string,
    ) => this.audit(actorId, eventType, resourceType, resourceId, metadata, organizationId);
    this.connectors = new ConnectorService(db, this.structure, audit, {
      allowPrivateNetwork: options.allowPrivateConnectorUrls ?? false,
    });
    this.actionPolicies = new ActionPolicyService(db, this.structure, audit);
    this.actions = new ActionGateway(db, this.execution, {
      loadManifest: (agentId, organizationId, employeeId) =>
        this.getManifest(agentId, organizationId, employeeId),
      bundle: (blueprintId, version) => this.catalog.bundle(blueprintId, version, 404),
      audit,
      connectors: this.connectors,
      policies: this.actionPolicies,
      secrets: options.secrets ?? new FileSecretStore(),
      signGrant: (payload) => this.signer.signExecutionGrant(payload),
      ...(options.connectorFetch ? { fetch: options.connectorFetch } : {}),
    });
    this.quality = new ModelQualityService(db);
    this.alertWebhooks = new AlertWebhookService(db, this.structure, this.signer, audit, {
      enabled: options.alertWebhooks ?? process.env['ALERT_WEBHOOKS_ENABLED'] === 'true',
      allowPrivateNetwork: options.allowPrivateWebhookUrls ?? false,
      ...(options.webhookSend ? { send: options.webhookSend } : {}),
    });
    this.modelSpending = new ModelSpendingService(db, this.structure, audit, (org, alert, nowMs) =>
      this.alertWebhooks.enqueueAlert(org, alert, nowMs),
    );
    this.runtimeTransport = new RuntimeTransportService(db, this.execution, {
      gateway: this.actions,
      audit,
      spending: this.modelSpending,
    });
  }

  private get db(): PgStore {
    return this.store;
  }

  /** A workflow from the exact catalog bundle the manifest pins; undefined if anything differs. */
  pinnedWorkflow(
    manifest: AnySignedAgentManifest,
    workflowId: string,
  ): WorkflowDefinition | undefined {
    if (manifest.payload.apiVersion !== 'agents-foundry/v2') return undefined;
    const { blueprint } = manifest.payload.metadata;
    if (!blueprint.digest || !manifest.payload.workflows.includes(workflowId)) return undefined;
    let bundle: ResolvedBlueprintBundle;
    try {
      bundle = this.catalog.bundle(blueprint.id, blueprint.version, 404);
    } catch {
      return undefined;
    }
    if (bundle.digest !== blueprint.digest) return undefined;
    return bundle.workflows.find((workflow) => workflow.id === workflowId);
  }

  // Accounts and sign-in: platform scope --------------------------------------------------------
  // Users, credentials, sessions and invitations are global; these flows filter by
  // organization explicitly.

  syncIdentities(issuer: string, entries: IdentityEntry[]): Promise<void> {
    return this.db.platform(async () => {
      await this.db.run('UPDATE identities SET enabled = 0 WHERE issuer = ?', issuer);
      for (const entry of entries) {
        const current = await this.db.get<{ organization_id: string }>(
          'SELECT organization_id FROM employees WHERE id = ?',
          entry.employeeId,
        );
        const identity = await this.db.get<{ employee_id: string }>(
          'SELECT employee_id FROM identities WHERE issuer = ? AND subject = ?',
          issuer,
          entry.subject,
        );
        if (
          (current && current.organization_id !== entry.organization.id) ||
          (identity && identity.employee_id !== entry.employeeId)
        )
          throw new Error('IDENTITY_REASSIGNMENT_FORBIDDEN');
        await this.db.run(
          'INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug',
          entry.organization.id,
          entry.organization.name,
          entry.organization.slug,
        );
        await this.db.run(
          'INSERT INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email, role = excluded.role, team = excluded.team',
          entry.employeeId,
          entry.organization.id,
          entry.displayName,
          entry.email,
          entry.role,
          entry.team,
        );
        await this.db.run(
          'INSERT INTO identities (issuer, subject, employee_id, enabled, user_id) VALUES (?, ?, ?, 1, ?) ON CONFLICT(issuer, subject) DO UPDATE SET enabled = 1',
          issuer,
          entry.subject,
          entry.employeeId,
          await this.ensureAccount(entry.employeeId, 'active'),
        );
        await this.db.run(
          'UPDATE users SET email=?,display_name=? WHERE id=(SELECT user_id FROM employees WHERE id=?)',
          entry.email,
          entry.displayName,
          entry.employeeId,
        );
        const credential = await this.db.get<{ hash: string }>(
          'SELECT hash FROM password_credentials WHERE issuer = ? AND subject = ?',
          issuer,
          entry.subject,
        );
        if (credential?.hash !== entry.passwordHash) {
          await this.db.run(
            'DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?',
            issuer,
            entry.subject,
          );
          await this.db.run(
            'DELETE FROM password_credentials WHERE issuer = ? AND subject = ?',
            issuer,
            entry.subject,
          );
          if (entry.passwordHash)
            await this.db.run(
              'INSERT INTO password_credentials (issuer, subject, hash) VALUES (?, ?, ?)',
              issuer,
              entry.subject,
              entry.passwordHash,
            );
        }
      }
      await this.db.run(
        'DELETE FROM auth_sessions WHERE issuer = ? AND subject IN (SELECT subject FROM identities WHERE issuer = ? AND enabled = 0)',
        issuer,
        issuer,
      );
      await this.db.run(
        `UPDATE organization_memberships SET membership_status='suspended',version=version+1,updated_at=?
        WHERE employee_id IN (SELECT employee_id FROM identities WHERE issuer=? AND enabled=0)
        AND NOT EXISTS(SELECT 1 FROM identities i WHERE i.employee_id=organization_memberships.employee_id AND i.enabled=1)`,
        now(),
        issuer,
      );
    });
  }

  createCustomer(organization: { name: string; slug: string }, admin: NewMember) {
    return this.db.platform(async () => {
      const organizationId = randomUUID();
      await this.db.run(
        'INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)',
        organizationId,
        organization.name,
        organization.slug,
      );
      const invitation = await this.insertInvitation(organizationId, admin, 'ADMIN');
      await this.audit(
        'platform-operator',
        'organization.created',
        'organization',
        organizationId,
        {},
        organizationId,
      );
      return { organizationId, ...invitation };
    });
  }

  private async insertInvitation(
    organizationId: string,
    member: NewMember,
    role: Actor['role'],
    invitedBy: string | null = null,
  ) {
    const email = member.email.trim().toLowerCase();
    if (
      await this.db.get(
        'SELECT id FROM employees WHERE organization_id=? AND lower(email)=lower(?::text)',
        organizationId,
        email,
      )
    )
      throw new Error('MEMBER_ALREADY_EXISTS');
    const existing = await this.activeAccount(email);
    if (!existing && (await this.accountByEmail(email))) throw new Error('ACCOUNT_NOT_ACTIVE');
    const employeeId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 48 * 3600000;
    await this.db.run(
      'INSERT INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?)',
      employeeId,
      organizationId,
      member.displayName,
      email,
      role,
      member.team,
    );
    if (existing)
      await this.db.run('UPDATE employees SET user_id=? WHERE id=?', existing, employeeId);
    const userId = await this.ensureAccount(employeeId, 'pending');
    if (existing)
      await this.db.run(
        'INSERT INTO account_link_invitations(hash,organization_id,employee_id,user_id,expires_at,invited_by) VALUES (?,?,?,?,?,?)',
        createHash('sha256').update(token).digest('hex'),
        organizationId,
        employeeId,
        userId,
        expiresAt,
        invitedBy,
      );
    else {
      await this.db.run(
        'INSERT INTO identities (issuer, subject, employee_id, enabled, user_id) VALUES (?, ?, ?, 0, ?)',
        LOCAL_ISSUER,
        employeeId,
        employeeId,
        userId,
      );
      await this.db.run(
        'INSERT INTO invitations (hash, employee_id, expires_at, consumed) VALUES (?, ?, ?, 0)',
        createHash('sha256').update(token).digest('hex'),
        employeeId,
        expiresAt,
      );
    }
    return {
      employeeId,
      token,
      expiresAt,
      purpose: existing ? ('link' as const) : ('activate' as const),
    };
  }

  /** An active account with a password, by email: invitations link to it instead. */
  private async activeAccount(email: string): Promise<string | undefined> {
    const row = await this.db.get<{ id: string }>(
      'SELECT u.id FROM users u JOIN account_password_credentials c ON c.user_id=u.id WHERE lower(u.email)=lower(?::text) AND u.status=?',
      email,
      'active',
    );
    return row?.id;
  }

  private async accountByEmail(email: string): Promise<boolean> {
    return Boolean(
      await this.db.get('SELECT id FROM users WHERE lower(email)=lower(?::text)', email),
    );
  }

  private async ensureAccount(employeeId: string, status: 'pending' | 'active'): Promise<string> {
    const employee = (await this.db.get(
      'SELECT id,user_id,organization_id,email,display_name,role FROM employees WHERE id=?',
      employeeId,
    ))!;
    const userId = (employee['user_id'] as string | null) ?? randomUUID();
    if (!employee['user_id']) {
      // Never link accounts by an unverified email match. Existing account linking is a separate consent flow.
      if (await this.accountByEmail(String(employee['email'])))
        throw new Error('MEMBER_ALREADY_EXISTS');
      await this.db.run(
        'INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)',
        userId,
        String(employee['email']),
        String(employee['display_name']),
        now(),
      );
      await this.db.run('UPDATE employees SET user_id=? WHERE id=?', userId, employeeId);
    }
    await this.db.run(
      `INSERT INTO organization_memberships(id,organization_id,user_id,employee_id,security_role,membership_status,joined_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,user_id) DO UPDATE SET
      membership_status=excluded.membership_status,security_role=excluded.security_role,
      version=organization_memberships.version+CASE WHEN organization_memberships.membership_status<>excluded.membership_status OR organization_memberships.security_role<>excluded.security_role THEN 1 ELSE 0 END,
      updated_at=excluded.updated_at`,
      randomUUID(),
      String(employee['organization_id']),
      userId,
      employeeId,
      String(employee['role']),
      status,
      now(),
      now(),
    );
    return userId;
  }

  inviteEmployee(actor: Actor, member: NewMember) {
    return this.db.platform(async () => {
      await this.structure.authorize(actor);
      const invitation = await this.insertInvitation(
        actor.organizationId,
        member,
        'EMPLOYEE',
        actor.id,
      );
      await this.audit(
        actor.id,
        'employee.invited',
        'employee',
        invitation.employeeId,
        {},
        actor.organizationId,
      );
      return invitation;
    });
  }

  inviteExistingEmployee(actor: Actor, employeeId: string) {
    return this.db.platform(async () => {
      await this.structure.authorize(actor);
      const employee = await this.db.get(
        "SELECT user_id,email FROM employees WHERE organization_id=? AND id=? AND employment_status='active'",
        actor.organizationId,
        employeeId,
      );
      if (!employee) throw new Error('MEMBER_NOT_FOUND');
      if (employee['user_id']) throw new Error('MEMBER_ALREADY_EXISTS');
      const email = String(employee['email']);
      const existing = await this.activeAccount(email);
      if (!existing && (await this.accountByEmail(email))) throw new Error('ACCOUNT_NOT_ACTIVE');
      if (existing)
        await this.db.run('UPDATE employees SET user_id=? WHERE id=?', existing, employeeId);
      const userId = await this.ensureAccount(employeeId, 'pending');
      const token = randomBytes(32).toString('base64url'),
        expiresAt = Date.now() + 48 * 3600000;
      if (existing)
        await this.db.run(
          'INSERT INTO account_link_invitations(hash,organization_id,employee_id,user_id,expires_at,invited_by) VALUES (?,?,?,?,?,?)',
          createHash('sha256').update(token).digest('hex'),
          actor.organizationId,
          employeeId,
          userId,
          expiresAt,
          actor.id,
        );
      else {
        await this.db.run(
          'INSERT INTO identities(issuer,subject,employee_id,enabled,user_id) VALUES (?,?,?,0,?)',
          LOCAL_ISSUER,
          employeeId,
          employeeId,
          userId,
        );
        await this.db.run(
          'INSERT INTO invitations(hash,employee_id,expires_at,consumed) VALUES (?,?,?,0)',
          createHash('sha256').update(token).digest('hex'),
          employeeId,
          expiresAt,
        );
      }
      await this.audit(
        actor.id,
        'employee.invited',
        'employee',
        employeeId,
        {},
        actor.organizationId,
      );
      return {
        employeeId,
        token,
        expiresAt,
        purpose: existing ? ('link' as const) : ('activate' as const),
      };
    });
  }

  acceptInvitation(hash: string, passwordHash: string): Promise<boolean> {
    return this.db.platform(async () => {
      const invitation = await this.db.get<{ employee_id: string }>(
        'SELECT employee_id FROM invitations WHERE hash = ? AND consumed = 0 AND expires_at > ?',
        hash,
        Date.now(),
      );
      if (!invitation) return false;
      const employeeId = invitation.employee_id;
      const employee = (await this.db.get<{ organization_id: string }>(
        'SELECT organization_id FROM employees WHERE id = ?',
        employeeId,
      ))!;
      await this.db.run('UPDATE invitations SET consumed = 1 WHERE employee_id = ?', employeeId);
      await this.db.run(
        'INSERT INTO password_credentials (issuer, subject, hash) VALUES (?, ?, ?)',
        LOCAL_ISSUER,
        employeeId,
        passwordHash,
      );
      await this.db.run(
        'INSERT INTO account_password_credentials(user_id,hash,updated_at) SELECT user_id,?,? FROM employees WHERE id=?',
        passwordHash,
        now(),
        employeeId,
      );
      await this.db.run(
        'UPDATE identities SET enabled = 1 WHERE issuer = ? AND subject = ?',
        LOCAL_ISSUER,
        employeeId,
      );
      await this.db.run(
        "UPDATE organization_memberships SET membership_status='active',version=version+1,updated_at=? WHERE employee_id=? AND membership_status='pending'",
        now(),
        employeeId,
      );
      await this.audit(
        employeeId,
        'employee.activated',
        'employee',
        employeeId,
        {},
        employee.organization_id,
      );
      return true;
    });
  }

  listMembers(organizationId: string) {
    return this.db.platform(() =>
      this.db.all(
        `SELECT e.id, e.display_name AS "displayName", e.email, e.role, e.team,
      CASE WHEN m.membership_status='suspended' OR e.employment_status='inactive' THEN 'INACTIVE'
      WHEN m.membership_status='active' AND c.user_id IS NOT NULL THEN 'ACTIVE'
      WHEN EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0 AND v.expires_at > ?) THEN 'INVITED'
      WHEN EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0) THEN 'INVITATION_EXPIRED'
      WHEN EXISTS (SELECT 1 FROM account_link_invitations l WHERE l.employee_id=e.id AND l.consumed=0 AND l.expires_at>?) THEN 'INVITED'
      ELSE 'INACTIVE' END AS status
      FROM employees e LEFT JOIN identities i ON i.employee_id = e.id AND i.issuer = ?
      JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id
      LEFT JOIN account_password_credentials c ON c.user_id=m.user_id
      WHERE e.organization_id = ? ORDER BY e.display_name`,
        Date.now(),
        Date.now(),
        LOCAL_ISSUER,
        organizationId,
      ),
    );
  }

  async disableMember(actor: Actor, employeeId: string): Promise<void> {
    if (actor.role !== 'ADMIN' || actor.id === employeeId) throw new Error('ACTOR_FORBIDDEN');
    await this.db.platform(async () => {
      if (
        !(await this.db.get(
          'SELECT id FROM employees WHERE id = ? AND organization_id = ? AND role = ?',
          employeeId,
          actor.organizationId,
          'EMPLOYEE',
        ))
      )
        throw new Error('MEMBER_NOT_FOUND');
      await this.db.run(
        'UPDATE identities SET enabled = 0 WHERE employee_id = ? AND issuer = ?',
        employeeId,
        LOCAL_ISSUER,
      );
      await this.db.run(
        "UPDATE organization_memberships SET membership_status='suspended',version=version+1,updated_at=? WHERE organization_id=? AND employee_id=?",
        now(),
        actor.organizationId,
        employeeId,
      );
      await this.db.run(
        'DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?',
        LOCAL_ISSUER,
        employeeId,
      );
      await this.db.run(
        'DELETE FROM auth_sessions WHERE organization_id=? AND user_id=(SELECT user_id FROM employees WHERE id=?)',
        actor.organizationId,
        employeeId,
      );
      await this.db.run('UPDATE invitations SET consumed = 1 WHERE employee_id = ?', employeeId);
      await this.db.run(
        'UPDATE password_resets SET consumed = 1 WHERE employee_id = ?',
        employeeId,
      );
      await this.audit(
        actor.id,
        'employee.disabled',
        'employee',
        employeeId,
        {},
        actor.organizationId,
      );
    });
  }

  issueEmployeeLink(actor: Actor, employeeId: string, purpose: 'activate' | 'reset') {
    if (actor.role !== 'ADMIN' || actor.id === employeeId) throw new Error('ACTOR_FORBIDDEN');
    return this.issueMemberLink(actor.organizationId, employeeId, purpose, actor.id, true);
  }

  // Only exposed through the operator CLI, never an HTTP route.
  issueOperatorLink(organizationId: string, employeeId: string, purpose: 'activate' | 'reset') {
    return this.issueMemberLink(organizationId, employeeId, purpose, 'platform-operator', false);
  }

  private issueMemberLink(
    organizationId: string,
    employeeId: string,
    purpose: 'activate' | 'reset',
    actorId: string,
    employeeOnly: boolean,
  ) {
    return this.db.platform(async () => {
      const target = await this.db.get<{
        role: Actor['role'];
        enabled: number;
        has_password: boolean;
        has_invitation: boolean;
      }>(
        `SELECT e.role, CASE WHEN m.membership_status='suspended' OR e.employment_status='inactive' THEN 0 ELSE i.enabled END AS enabled,
        EXISTS (SELECT 1 FROM password_credentials p WHERE p.issuer = i.issuer AND p.subject = i.subject) AS has_password,
        EXISTS (SELECT 1 FROM invitations v WHERE v.employee_id = e.id AND v.consumed = 0) AS has_invitation
        FROM employees e JOIN identities i ON i.employee_id = e.id AND i.issuer = ?
        JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id
        WHERE e.organization_id = ? AND e.id = ?`,
        LOCAL_ISSUER,
        organizationId,
        employeeId,
      );
      if (!target || (employeeOnly && target.role !== 'EMPLOYEE'))
        throw new Error('MEMBER_NOT_FOUND');
      if (
        purpose === 'activate'
          ? target.enabled || target.has_password || !target.has_invitation
          : !target.enabled || !target.has_password
      )
        throw new Error('RECOVERY_STATE_CONFLICT');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + (purpose === 'activate' ? 48 : 1) * 3600000;
      // Purpose-specific tables ensure activation links cannot be used to reset passwords.
      const table = purpose === 'activate' ? 'invitations' : 'password_resets';
      await this.db.run(`UPDATE ${table} SET consumed = 1 WHERE employee_id = ?`, employeeId);
      await this.db.run(
        `INSERT INTO ${table} (hash, employee_id, expires_at, consumed) VALUES (?, ?, ?, 0)`,
        createHash('sha256').update(token).digest('hex'),
        employeeId,
        expiresAt,
      );
      await this.audit(
        actorId,
        purpose === 'activate' ? 'employee.invitation.reissued' : 'employee.password_reset.issued',
        'employee',
        employeeId,
        {},
        organizationId,
      );
      return { employeeId, token, expiresAt, role: target.role };
    });
  }

  resetPassword(hash: string, passwordHash: string): Promise<boolean> {
    return this.db.platform(async () => {
      const reset = await this.db.get<{ employee_id: string; organization_id: string }>(
        `SELECT r.employee_id, e.organization_id FROM password_resets r
        JOIN employees e ON e.id = r.employee_id
        JOIN identities i ON i.employee_id = e.id AND i.issuer = ? AND i.enabled = 1
        JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.membership_status='active'
        JOIN password_credentials p ON p.issuer = i.issuer AND p.subject = i.subject
        WHERE r.hash = ? AND r.consumed = 0 AND r.expires_at > ?`,
        LOCAL_ISSUER,
        hash,
        Date.now(),
      );
      if (!reset) return false;
      await this.db.run(
        'UPDATE password_credentials SET hash = ? WHERE issuer = ? AND subject = ?',
        passwordHash,
        LOCAL_ISSUER,
        reset.employee_id,
      );
      await this.db.run(
        'UPDATE account_password_credentials SET hash=?,updated_at=? WHERE user_id=(SELECT user_id FROM employees WHERE id=?)',
        passwordHash,
        now(),
        reset.employee_id,
      );
      await this.db.run(
        'UPDATE password_resets SET consumed = 1 WHERE employee_id = ?',
        reset.employee_id,
      );
      await this.db.run(
        'DELETE FROM auth_sessions WHERE issuer = ? AND subject = ?',
        LOCAL_ISSUER,
        reset.employee_id,
      );
      await this.db.run(
        'DELETE FROM auth_sessions WHERE user_id=(SELECT user_id FROM employees WHERE id=?)',
        reset.employee_id,
      );
      await this.audit(
        reset.employee_id,
        'employee.password_reset.completed',
        'employee',
        reset.employee_id,
        {},
        reset.organization_id,
      );
      return true;
    });
  }

  findIdentity(
    issuer: string,
    subject: string,
    organizationId?: string,
  ): Promise<Actor | undefined> {
    return this.db.platform(async () => {
      const row = await this.db.get<{ id: string; organization_id: string; role: Actor['role'] }>(
        `SELECT e.id,e.organization_id,m.security_role AS role FROM identities i
         JOIN users u ON u.id=i.user_id AND u.status='active'
         JOIN employees e ON e.id=i.employee_id AND e.user_id=u.id AND e.employment_status='active'
         JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.user_id=u.id AND m.membership_status='active'
         JOIN organizations o ON o.id=m.organization_id AND o.status='active'
         WHERE i.issuer=? AND i.subject=? AND i.enabled=1 AND (?::text IS NULL OR e.organization_id=?)`,
        issuer,
        subject,
        organizationId ?? null,
        organizationId ?? null,
      );
      return row ? { id: row.id, organizationId: row.organization_id, role: row.role } : undefined;
    });
  }

  findPasswordIdentity(
    issuer: string,
    email: string,
    organizationId?: string,
  ): Promise<{ subject: string; hash: string } | undefined> {
    return this.db.platform(async () => {
      const rows = await this.db.all<{ subject: string; hash: string }>(
        `SELECT i.subject, p.hash FROM identities i
      JOIN employees e ON e.id = i.employee_id
      JOIN users u ON u.id=i.user_id AND u.id=e.user_id AND u.status='active'
      JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.employee_id=e.id AND m.user_id=u.id AND m.membership_status='active'
      JOIN organizations o ON o.id=e.organization_id AND o.status='active'
      JOIN password_credentials p ON p.issuer = i.issuer AND p.subject = i.subject
      WHERE i.issuer = ? AND i.enabled = 1 AND e.employment_status='active' AND lower(u.email) = ? AND (?::text IS NULL OR e.organization_id=?)`,
        issuer,
        email.toLowerCase(),
        organizationId ?? null,
        organizationId ?? null,
      );
      return rows.length === 1 ? rows[0] : undefined;
    });
  }

  accountMembership(userId: string, organizationId: string): Promise<Actor | undefined> {
    return this.db.platform(async () => {
      const row = await this.db.get<{ id: string; organization_id: string; role: Actor['role'] }>(
        `SELECT e.id,e.organization_id,m.security_role AS role FROM organization_memberships m
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id AND e.user_id=u.id AND e.employment_status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      WHERE m.user_id=? AND m.organization_id=? AND m.membership_status='active'`,
        userId,
        organizationId,
      );
      return row ? { id: row.id, organizationId: row.organization_id, role: row.role } : undefined;
    });
  }

  findPasswordAccount(
    email: string,
    organizationId?: string,
    role?: Actor['role'],
  ): Promise<{ userId: string; hash: string; organizationId: string } | undefined> {
    return this.db.platform(async () => {
      const user = await this.db.get<{ id: string; hash: string }>(
        `SELECT u.id,c.hash FROM users u
      JOIN account_password_credentials c ON c.user_id=u.id
      WHERE lower(u.email)=lower(?::text) AND u.status='active'`,
        email.trim(),
      );
      if (!user) return undefined;
      const memberships = await this.db.all(
        `SELECT m.organization_id,m.security_role FROM organization_memberships m
      JOIN employees e ON e.id=m.employee_id AND e.organization_id=m.organization_id AND e.employment_status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      WHERE m.user_id=? AND m.membership_status='active' AND (?::text IS NULL OR m.organization_id=?)
      ORDER BY m.joined_at,m.organization_id`,
        user.id,
        organizationId ?? null,
        organizationId ?? null,
      );
      const selected = memberships.find((item) => item['security_role'] === role) ?? memberships[0];
      return selected
        ? { userId: user.id, hash: user.hash, organizationId: String(selected['organization_id']) }
        : undefined;
    });
  }

  listAccountMemberships(actor: Actor, hostOrganizationId?: string) {
    return this.db.platform(() =>
      this.db.all(
        `SELECT m.organization_id AS "organizationId",o.name AS "organizationName",m.security_role AS role,e.id AS "employeeId"
      FROM employees current JOIN organization_memberships m ON m.user_id=current.user_id
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      JOIN employees e ON e.id=m.employee_id AND e.employment_status='active'
      WHERE current.id=? AND current.organization_id=? AND m.membership_status='active' AND (?::text IS NULL OR m.organization_id=?)
      ORDER BY o.name,m.organization_id`,
        actor.id,
        actor.organizationId,
        hostOrganizationId ?? null,
        hostOrganizationId ?? null,
      ),
    );
  }

  accountSessionUser(hash: string): Promise<string | undefined> {
    return this.db.platform(async () => {
      const row = await this.db.get(
        'SELECT user_id FROM auth_sessions WHERE hash=? AND issuer=? AND expires_at>?',
        hash,
        LOCAL_ISSUER,
        Date.now(),
      );
      return row?.['user_id'] ? String(row['user_id']) : undefined;
    });
  }

  createAccountSession(
    hash: string,
    userId: string,
    organizationId: string,
    expiresAt: number,
  ): Promise<Actor> {
    return this.db.platform(async () => {
      const actor = await this.accountMembership(userId, organizationId);
      if (!actor) throw new Error('MEMBERSHIP_REQUIRED');
      await this.db.run('DELETE FROM auth_sessions WHERE expires_at<=?', Date.now());
      await this.db.run(
        'INSERT INTO auth_sessions(hash,issuer,subject,expires_at,user_id,organization_id) VALUES (?,?,?,?,?,?)',
        hash,
        LOCAL_ISSUER,
        userId,
        expiresAt,
        userId,
        organizationId,
      );
      return actor;
    });
  }

  previewAccountLink(hash: string, userId: string): Promise<Row | undefined> {
    return this.db.platform(() =>
      this.db.get(
        `SELECT l.organization_id AS "organizationId",o.name AS "organizationName",m.security_role AS role,l.expires_at AS "expiresAt"
      FROM account_link_invitations l JOIN organization_memberships m ON m.organization_id=l.organization_id AND m.employee_id=l.employee_id AND m.user_id=l.user_id
      JOIN employees e ON e.id=l.employee_id AND e.employment_status='active'
      JOIN organizations o ON o.id=l.organization_id AND o.status='active'
      WHERE l.hash=? AND l.user_id=? AND l.consumed=0 AND l.expires_at>? AND m.membership_status='pending'`,
        hash,
        userId,
        Date.now(),
      ),
    );
  }

  acceptAccountLink(hash: string, userId: string): Promise<Actor | undefined> {
    return this.db.platform(async () => {
      const preview = await this.previewAccountLink(hash, userId);
      if (!preview) return undefined;
      await this.db.run(
        "UPDATE organization_memberships SET membership_status='active',version=version+1,updated_at=? WHERE organization_id=? AND user_id=? AND membership_status='pending'",
        now(),
        String(preview['organizationId']),
        userId,
      );
      await this.db.run('UPDATE account_link_invitations SET consumed=1 WHERE hash=?', hash);
      const actor = await this.accountMembership(userId, String(preview['organizationId']));
      if (!actor) throw new Error('LINK_MEMBERSHIP_UNAVAILABLE');
      await this.audit(
        actor.id,
        'account.linked',
        'organization_membership',
        actor.id,
        { userId },
        actor.organizationId,
      );
      return actor;
    });
  }

  createLogin(hash: string, transaction: LoginTransaction, expiresAt: number): Promise<void> {
    return this.db.platform(async () => {
      await this.db.run('DELETE FROM login_transactions WHERE expires_at <= ?', Date.now());
      await this.db.run(
        'INSERT INTO login_transactions (hash, body, expires_at) VALUES (?, ?, ?)',
        hash,
        JSON.stringify(transaction),
        expiresAt,
      );
    });
  }
  discardLogin(hash: string): Promise<void> {
    return this.db.platform(async () => {
      await this.db.run('DELETE FROM login_transactions WHERE hash = ?', hash);
    });
  }
  consumeLogin(hash: string): Promise<LoginTransaction | undefined> {
    return this.db.platform(async () => {
      const row = await this.db.get<{ body: string; expires_at: number }>(
        'DELETE FROM login_transactions WHERE hash = ? RETURNING body, expires_at',
        hash,
      );
      return row && row.expires_at > Date.now()
        ? (JSON.parse(row.body) as LoginTransaction)
        : undefined;
    });
  }
  createSession(hash: string, issuer: string, subject: string, expiresAt: number): Promise<void> {
    return this.db.platform(async () => {
      await this.db.run('DELETE FROM auth_sessions WHERE expires_at <= ?', Date.now());
      const identity = await this.db.get(
        'SELECT i.user_id,e.organization_id FROM identities i JOIN employees e ON e.id=i.employee_id WHERE i.issuer=? AND i.subject=?',
        issuer,
        subject,
      );
      await this.db.run(
        'INSERT INTO auth_sessions (hash, issuer, subject, expires_at, user_id, organization_id) VALUES (?, ?, ?, ?, ?, ?)',
        hash,
        issuer,
        subject,
        expiresAt,
        (identity?.['user_id'] as string | null | undefined) ?? null,
        (identity?.['organization_id'] as string | null | undefined) ?? null,
      );
    });
  }
  deleteSession(hash: string): Promise<void> {
    return this.db.platform(async () => {
      await this.db.run('DELETE FROM auth_sessions WHERE hash = ?', hash);
    });
  }
  findSession(hash: string, organizationId?: string): Promise<Actor | undefined> {
    return this.db.platform(async () => {
      const row = await this.db.get<{
        issuer: string;
        subject: string;
        user_id: string | null;
        organization_id: string | null;
      }>(
        'SELECT issuer, subject, user_id, organization_id FROM auth_sessions WHERE hash = ? AND expires_at > ?',
        hash,
        Date.now(),
      );
      if (!row) return undefined;
      if (row.issuer === LOCAL_ISSUER && row.user_id && row.organization_id)
        return organizationId && organizationId !== row.organization_id
          ? undefined
          : this.accountMembership(row.user_id, row.organization_id);
      return this.findIdentity(row.issuer, row.subject, organizationId);
    });
  }

  resolveActor(id: string, role: string, organizationId: string) {
    // Explicit local-demo identities only. Replace with verified OIDC claims before deployment.
    if (organizationId !== ORGANIZATION_ID) throw new Error('ACTOR_FORBIDDEN');
    if (role === 'ADMIN' && id === 'admin_demo') return;
    if (role === 'EMPLOYEE' && id === EMPLOYEE_ID) return;
    throw new Error('ACTOR_FORBIDDEN');
  }

  // Tenant data: tenant scope (row-level security) ------------------------------------------------

  requestProvisioning(
    employeeId: string,
    input: ProvisioningInput,
    organizationId = ORGANIZATION_ID,
  ): Promise<ProvisioningRequest> {
    return this.db.tenant(organizationId, async () => {
      if (
        !(await this.db.get(
          "SELECT id FROM employees WHERE id = ? AND organization_id = ? AND role = 'EMPLOYEE'",
          employeeId,
          organizationId,
        ))
      )
        throw new Error('ACTOR_FORBIDDEN');
      const bundle = this.catalog.bundle(input.blueprintId, input.blueprintVersion);
      const request: ProvisioningRequest = {
        ...input,
        answers: this.catalog.validateAnswers(bundle, input.answers, 'ALL'),
        id: randomUUID(),
        organizationId,
        employeeId,
        status: 'PENDING',
        capabilities: bundle.capabilities,
        createdAt: now(),
      };
      await this.db.run(
        'INSERT INTO provisioning_requests (id, organization_id, employee_id, body) VALUES (?, ?, ?, ?)',
        request.id,
        request.organizationId,
        employeeId,
        JSON.stringify(request),
      );
      await this.audit(
        employeeId,
        'provisioning.requested',
        'provisioning_request',
        request.id,
        {
          blueprintId: input.blueprintId,
          blueprintVersion: input.blueprintVersion,
        },
        organizationId,
      );
      return request;
    });
  }

  createAssignedAgents(actor: Actor, input: AdminAgentInput): Promise<AgentAssignment[]> {
    return this.db.tenant(actor.organizationId, async () => {
      if (
        actor.role !== 'ADMIN' ||
        !(await this.db.get(
          `SELECT e.id FROM employees e
      JOIN organization_memberships m ON m.employee_id=e.id AND m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.membership_status='active'
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      JOIN account_password_credentials c ON c.user_id=u.id
      WHERE e.id = ? AND e.organization_id = ? AND m.security_role = 'ADMIN' AND e.employment_status='active'`,
          actor.id,
          actor.organizationId,
        ))
      )
        throw new Error('ACTOR_FORBIDDEN');
      const bodyHash = createHash('sha256')
        .update(JSON.stringify({ actorId: actor.id, ...input }))
        .digest('hex');
      const previous = await this.db.get<{ body_hash: string; result: string }>(
        'SELECT body_hash, result FROM admin_agent_batches WHERE organization_id = ? AND request_id = ?',
        actor.organizationId,
        input.requestId,
      );
      if (previous) {
        if (previous.body_hash !== bodyHash) throw new Error('IDEMPOTENCY_CONFLICT');
        return JSON.parse(previous.result) as AgentAssignment[];
      }
      // Resolved after the replay check: an unchanged retry returns its original result even
      // if the installation was retired since. Retirement still blocks new agents (trigger).
      const bundle = this.catalog.bundle(input.blueprintId, input.blueprintVersion);
      const installation = input.installationId
        ? await this.installations.activeInstallation(actor.organizationId, input.installationId)
        : null;
      if (
        installation &&
        (installation.blueprintId !== input.blueprintId ||
          installation.blueprintVersion !== input.blueprintVersion)
      )
        throw new OrganizationDomainError(409, 'INSTALLATION_BLUEPRINT_MISMATCH');
      const answers = this.catalog.resolveAnswers(bundle, installation, input.answers);
      // Check every recipient before creating anything; invitations and disabled users are ineligible.
      const recipients: { id: string; display_name: string; team: string }[] = [];
      for (const employeeId of input.employeeIds) {
        const employee = await this.db.get<{ id: string; display_name: string; team: string }>(
          `SELECT e.id, e.display_name, e.team FROM employees e
          JOIN organization_memberships m ON m.employee_id=e.id AND m.organization_id=e.organization_id AND m.user_id=e.user_id AND m.membership_status='active'
          JOIN users u ON u.id=m.user_id AND u.status='active'
          JOIN organizations o ON o.id=m.organization_id AND o.status='active'
          JOIN account_password_credentials c ON c.user_id=u.id
          WHERE e.id = ? AND e.organization_id = ? AND m.security_role = 'EMPLOYEE' AND e.employment_status='active'`,
          employeeId,
          actor.organizationId,
        );
        if (!employee) throw new Error('ASSIGNMENT_RECIPIENT_FORBIDDEN');
        recipients.push(employee);
      }
      const assignments: AgentAssignment[] = [];
      for (const employee of recipients) {
        const agentId = randomUUID(),
          createdAt = now();
        const manifest = this.issueManifest({
          manifestId: randomUUID(),
          agentId,
          organizationId: actor.organizationId,
          employeeId: employee.id,
          issuedAt: createdAt,
          agentName: input.name,
          bundle,
          installationId: installation?.id ?? null,
          provider: input.provider,
          model: input.model,
          credentialMode: input.credentialMode,
          answers,
          capabilities: structuredClone(bundle.capabilities),
        });
        await this.db.run(
          'INSERT INTO agents (id, organization_id, name, department, team, status, capabilities, installation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          agentId,
          actor.organizationId,
          input.name,
          bundle.blueprint.department,
          employee.team,
          'ACTIVE',
          JSON.stringify(
            bundle.capabilities.filter((c) => c.outcome !== 'DENY').map((c) => c.action),
          ),
          installation?.id ?? null,
        );
        await this.db.run(
          'INSERT INTO agent_manifests (agent_id, organization_id, employee_id, body) VALUES (?, ?, ?, ?)',
          agentId,
          actor.organizationId,
          employee.id,
          JSON.stringify(manifest),
        );
        await this.db.run(
          'INSERT INTO agent_assignments (agent_id, organization_id, created_by, created_at) VALUES (?, ?, ?, ?)',
          agentId,
          actor.organizationId,
          actor.id,
          createdAt,
        );
        await this.audit(
          actor.id,
          'agent.admin_created',
          'agent',
          agentId,
          {
            blueprintId: input.blueprintId,
            blueprintVersion: input.blueprintVersion,
            blueprintDigest: bundle.digest,
            installationId: installation?.id ?? null,
            requestId: input.requestId,
          },
          actor.organizationId,
        );
        await this.audit(
          actor.id,
          'agent.assigned',
          'agent',
          agentId,
          { employeeId: employee.id },
          actor.organizationId,
        );
        await this.audit(
          actor.id,
          'agent.manifest.issued',
          'agent',
          agentId,
          {
            manifestId: manifestSubject(manifest.payload).manifestId,
            apiVersion: manifest.payload.apiVersion,
            keyId: manifest.keyId,
          },
          actor.organizationId,
        );
        assignments.push({
          agentId,
          name: input.name,
          employeeId: employee.id,
          employeeName: employee.display_name,
          createdBy: actor.id,
          createdAt,
        });
      }
      await this.db.run(
        'INSERT INTO admin_agent_batches (organization_id, request_id, body_hash, result) VALUES (?, ?, ?, ?)',
        actor.organizationId,
        input.requestId,
        bodyHash,
        JSON.stringify(assignments),
      );
      return assignments;
    });
  }

  listAgentAssignments(organizationId: string): Promise<AgentAssignment[]> {
    return this.db.tenant(
      organizationId,
      async () =>
        (await this.db.all(
          `SELECT a.id AS "agentId", a.name, m.employee_id AS "employeeId", e.display_name AS "employeeName",
      s.created_by AS "createdBy", s.created_at AS "createdAt" FROM agent_assignments s
      JOIN agents a ON a.id = s.agent_id JOIN agent_manifests m ON m.agent_id = a.id
      JOIN employees e ON e.id = m.employee_id WHERE a.organization_id = ? ORDER BY s.created_at DESC, a.id`,
          organizationId,
        )) as unknown as AgentAssignment[],
    );
  }

  listProvisioning(organizationId: string, employeeId?: string): Promise<ProvisioningRequest[]> {
    return this.db.tenant(organizationId, async () => {
      const rows = await this.db.all<{ body: string }>(
        'SELECT body FROM provisioning_requests WHERE organization_id = ? ORDER BY seq DESC',
        organizationId,
      );
      return rows
        .map((row) => JSON.parse(row.body) as ProvisioningRequest)
        .filter((item) => !employeeId || item.employeeId === employeeId);
    });
  }

  decideProvisioning(
    id: string,
    organizationId: string,
    actorId: string,
    decision: 'APPROVED' | 'REJECTED',
    reason: string,
  ) {
    return this.db.tenant(organizationId, async () => {
      const row = await this.db.get<{ body: string }>(
        'SELECT body FROM provisioning_requests WHERE id = ? AND organization_id = ?',
        id,
        organizationId,
      );
      if (!row) throw new Error('PROVISIONING_NOT_FOUND');
      const request = JSON.parse(row.body) as ProvisioningRequest;
      if (request.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
      if (request.employeeId === actorId) throw new Error('SELF_APPROVAL_FORBIDDEN');
      Object.assign(request, {
        status: decision,
        decidedBy: actorId,
        decidedAt: now(),
        decisionReason: reason,
      });
      let manifest: AnySignedAgentManifest | undefined;
      if (decision === 'APPROVED') {
        request.agentId = randomUUID();
        const bundle = this.catalog.bundle(request.blueprintId, request.blueprintVersion);
        const agentName = agentLabel(bundle, request.answers);
        manifest = this.issueManifest({
          manifestId: randomUUID(),
          agentId: request.agentId,
          organizationId,
          employeeId: request.employeeId,
          issuedAt: request.decidedAt!,
          agentName,
          bundle,
          installationId: null,
          provider: request.provider,
          model: request.model,
          credentialMode: request.credentialMode,
          answers: request.answers,
          capabilities: request.capabilities,
        });
        await this.db.run(
          'INSERT INTO agents (id, organization_id, name, department, team, status, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)',
          request.agentId,
          organizationId,
          agentName,
          bundle.blueprint.department,
          await this.employeeTeam(request.employeeId, organizationId),
          'ACTIVE',
          JSON.stringify(
            request.capabilities.filter((c) => c.outcome !== 'DENY').map((c) => c.action),
          ),
        );
        await this.db.run(
          'INSERT INTO agent_manifests (agent_id, organization_id, employee_id, body) VALUES (?, ?, ?, ?)',
          request.agentId,
          organizationId,
          request.employeeId,
          JSON.stringify(manifest),
        );
        await this.audit(
          actorId,
          'agent.manifest.issued',
          'agent',
          request.agentId,
          {
            manifestId: manifestSubject(manifest.payload).manifestId,
            apiVersion: manifest.payload.apiVersion,
            keyId: manifest.keyId,
          },
          organizationId,
        );
      }
      await this.db.run(
        'UPDATE provisioning_requests SET body = ? WHERE id = ? AND organization_id = ?',
        JSON.stringify(request),
        id,
        organizationId,
      );
      await this.audit(
        actorId,
        decision === 'APPROVED' ? 'provisioning.approved' : 'provisioning.rejected',
        'provisioning_request',
        id,
        { agentId: request.agentId ?? null, reason },
        organizationId,
      );
      return { request, ...(manifest ? { manifest } : {}) };
    });
  }

  private async employeeTeam(employeeId: string, organizationId: string): Promise<string> {
    const row = await this.db.get<{ team: string }>(
      'SELECT team FROM employees WHERE id = ? AND organization_id = ?',
      employeeId,
      organizationId,
    );
    return row?.team ?? '';
  }

  private issueManifest(issue: ManifestIssue): AnySignedAgentManifest {
    const manifest = this.signer.sign(
      buildManifestPayload(issue, this.manifestV2Issuance),
    ) as AnySignedAgentManifest;
    if (!this.signer.verify(manifest)) throw new Error('MANIFEST_INVALID');
    return manifest;
  }

  /** Fails closed on unknown versions, malformed structure, bad signatures or rebinding. */
  getManifest(
    agentId: string,
    organizationId: string,
    employeeId?: string,
  ): Promise<AnySignedAgentManifest> {
    return this.db.tenant(organizationId, async () => {
      const row = await this.db.get<{ body: string; employee_id: string }>(
        'SELECT body, employee_id FROM agent_manifests WHERE agent_id = ? AND organization_id = ?',
        agentId,
        organizationId,
      );
      if (!row || (employeeId && row.employee_id !== employeeId))
        throw new Error('MANIFEST_NOT_FOUND');
      let manifest: AnySignedAgentManifest;
      try {
        manifest = parseSignedManifest(JSON.parse(row.body));
      } catch {
        throw new Error('MANIFEST_INVALID');
      }
      const subject = manifestSubject(manifest.payload);
      if (
        !this.signer.verify(manifest) ||
        subject.agentId !== agentId ||
        subject.organizationId !== organizationId ||
        subject.employeeId !== row.employee_id
      )
        throw new Error('MANIFEST_INVALID');
      return manifest;
    });
  }

  listLifecycleEvents(organizationId: string): Promise<LifecycleEvent[]> {
    return this.db.tenant(organizationId, async () => {
      const rows = await this.db.all(
        "SELECT * FROM audit_events WHERE organization_id = ? AND event_type IN ('provisioning.requested', 'provisioning.approved', 'provisioning.rejected', 'agent.manifest.issued', 'organization.created', 'employee.invited', 'employee.activated', 'employee.disabled', 'employee.invitation.reissued', 'employee.password_reset.issued', 'employee.password_reset.completed', 'agent.admin_created', 'agent.assigned') ORDER BY seq DESC LIMIT 100",
        organizationId,
      );
      return rows.map((row) => ({
        id: String(row['id']),
        organizationId,
        actorId: String(row['actor_id']),
        type: String(row['event_type']) as LifecycleEvent['type'],
        subjectId: String(row['resource_id']),
        occurredAt: String(row['created_at']),
        data: JSON.parse(String(row['metadata'])),
      }));
    });
  }

  close(): Promise<void> {
    this.tenancy.domains.stop();
    return this.store.close();
  }

  getBootstrap(actor: Actor = demoEmployee, allowDemo = true): Promise<BootstrapResponse> {
    return this.db.tenant(actor.organizationId, async () => {
      const organization = (await this.db.get(
        'SELECT id, name, slug FROM organizations WHERE id = ?',
        actor.organizationId,
      )) as unknown as Organization | undefined;
      const employeeRow = await this.db.get(
        'SELECT id, organization_id, display_name, email, role, team FROM employees WHERE id = ? AND organization_id = ?',
        actor.id,
        actor.organizationId,
      );
      if (!organization || !employeeRow) throw new Error('ACTOR_FORBIDDEN');
      const agentRows = await this.db.all(
        `SELECT id, organization_id, name, department, team, status, capabilities FROM agents a WHERE organization_id = ?
         AND (?::text = 'ADMIN' OR EXISTS (SELECT 1 FROM agent_manifests m WHERE m.agent_id = a.id AND m.employee_id = ?) OR (?::int = 1 AND a.id = ?))
         AND (?::int = 1 OR a.id != ?) ORDER BY seq`,
        actor.organizationId,
        actor.role,
        actor.id,
        allowDemo ? 1 : 0,
        AGENT_ID,
        allowDemo ? 1 : 0,
        AGENT_ID,
      );
      const agents: AgentDefinition[] = [];
      for (const row of agentRows) agents.push(await this.mapAgent(row));
      return {
        organization,
        employee: this.mapEmployee(employeeRow),
        agents,
        keyPolicy: {
          allowedSources: ['EMPLOYEE_BYOK', 'ORGANIZATION_MANAGED'],
          defaultSource: 'ORGANIZATION_MANAGED',
          secretStorageRule:
            'Only an external vault reference may be stored; raw provider keys are prohibited.',
        },
      };
    });
  }

  listConversations(employeeId: string, organizationId = ORGANIZATION_ID): Promise<Conversation[]> {
    return this.db.tenant(organizationId, async () => {
      const rows = await this.db.all(
        `SELECT id, organization_id, employee_id, agent_id, title, created_at, updated_at
         FROM conversations WHERE employee_id = ? AND organization_id = ? ORDER BY updated_at DESC, id`,
        employeeId,
        organizationId,
      );
      return rows.map((row) => this.mapConversation(row));
    });
  }

  createConversation(
    employeeId: string,
    agentId: string,
    title: string,
    organizationId = ORGANIZATION_ID,
    allowDemo = true,
  ): Promise<Conversation> {
    return this.db.tenant(organizationId, async () => {
      if (
        !(await this.db.get(
          'SELECT id FROM employees WHERE id = ? AND organization_id = ?',
          employeeId,
          organizationId,
        ))
      )
        throw new Error('ACTOR_FORBIDDEN');
      if (
        !(await this.db.get(
          "SELECT id FROM agents WHERE id = ? AND organization_id = ? AND status = 'ACTIVE'",
          agentId,
          organizationId,
        ))
      )
        throw new Error('AGENT_NOT_FOUND');
      if (agentId !== AGENT_ID || !allowDemo)
        await this.getManifest(agentId, organizationId, employeeId);
      const id = randomUUID();
      const timestamp = now();
      await this.db.run(
        `INSERT INTO conversations
         (id, organization_id, employee_id, agent_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        organizationId,
        employeeId,
        agentId,
        title,
        timestamp,
        timestamp,
      );
      await this.audit(
        employeeId,
        'conversation.created',
        'conversation',
        id,
        { title },
        organizationId,
      );
      return this.getConversation(id, organizationId, employeeId);
    });
  }

  getConversation(
    id: string,
    organizationId = ORGANIZATION_ID,
    employeeId?: string,
  ): Promise<ConversationDetail> {
    return this.db.tenant(organizationId, async () => {
      const row = await this.db.get(
        `SELECT id, organization_id, employee_id, agent_id, title, created_at, updated_at
         FROM conversations WHERE id = ? AND organization_id = ?`,
        id,
        organizationId,
      );
      if (!row || (employeeId && row['employee_id'] !== employeeId))
        throw new Error('CONVERSATION_NOT_FOUND');
      const messages = await this.db.all(
        `SELECT id, conversation_id, author, content, created_at
         FROM messages WHERE conversation_id = ? AND organization_id = ? ORDER BY created_at ASC, seq ASC`,
        id,
        organizationId,
      );
      return {
        ...this.mapConversation(row),
        messages: messages.map((message) => this.mapMessage(message)),
      };
    });
  }

  addMessage(
    conversationId: string,
    author: ConversationMessage['author'],
    content: string,
    organizationId = ORGANIZATION_ID,
    employeeId?: string,
  ): Promise<ConversationMessage> {
    return this.db.tenant(organizationId, async () => {
      const conversation = await this.getConversation(conversationId, organizationId, employeeId);
      const id = randomUUID();
      const timestamp = now();
      await this.db.run(
        'INSERT INTO messages (id, organization_id, conversation_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        organizationId,
        conversationId,
        author,
        content,
        timestamp,
      );
      await this.db.run(
        'UPDATE conversations SET updated_at = ? WHERE id = ? AND organization_id = ?',
        timestamp,
        conversationId,
        organizationId,
      );
      await this.audit(
        author === 'EMPLOYEE' ? conversation.employeeId : 'agent-runtime',
        'message.created',
        'conversation',
        conversationId,
        { messageId: id },
        organizationId,
      );
      return { id, conversationId, author, content, createdAt: timestamp };
    });
  }

  /**
   * Phase F: queue a generic `validate-story` run instead of the legacy static plan. Returns
   * null when the agent is not eligible (no v2 manifest, or the workflow is not in its pinned
   * catalog bundle); the caller then uses the legacy path, which executes nothing.
   */
  createGenericQaRun(
    input: {
      employeeId: string;
      conversationId: string;
      storyKey: string;
      targetUrl: string;
      instructions?: string;
    },
    organizationId: string,
    allowDemo: boolean,
  ): Promise<GenericQaRunResponse | null> {
    return this.db.tenant(organizationId, async () => {
      const conversation = await this.getConversation(input.conversationId, organizationId);
      if (conversation.employeeId !== input.employeeId) throw new Error('CONVERSATION_FORBIDDEN');
      if (conversation.agentId === AGENT_ID && allowDemo) return null;
      const manifest = await this.getManifest(
        conversation.agentId,
        organizationId,
        input.employeeId,
      );
      if (
        manifest.payload.apiVersion !== 'agents-foundry/v2' ||
        !this.pinnedWorkflow(manifest, QA_WORKFLOW)
      )
        return null;
      // Checked again by Policy v2 for every browser run; refused here so nothing is queued.
      const qaUrl = manifest.payload.configuration['qaUrl'];
      if (typeof qaUrl !== 'string' || new URL(qaUrl).origin !== new URL(input.targetUrl).origin)
        throw new OrganizationDomainError(400, 'TARGET_OUT_OF_SCOPE');
      const origin = new URL(input.targetUrl).origin;
      const task: TaskSpec = {
        objective:
          `Validate ${input.storyKey} against ${origin}: read the story and its acceptance ` +
          'criteria, check out the configured repository, run the Playwright checks, and file ' +
          'defects for failures you can evidence.',
        workflow: QA_WORKFLOW,
        workItem: { system: 'issue-tracker', key: input.storyKey },
        inputs: {
          targetUrl: input.targetUrl,
          ...(input.instructions ? { instructions: input.instructions } : {}),
        },
      };
      const run = await this.execution.createRun({
        organizationId,
        employeeId: input.employeeId,
        agentId: conversation.agentId,
        title: `${input.storyKey} QA validation`,
        task,
        manifest,
        conversation: { id: conversation.id, title: conversation.title },
      });
      await this.audit(
        input.employeeId,
        'qa_run.requested',
        'agent_run',
        run.id,
        { storyKey: input.storyKey, mode: 'GENERIC_RUNTIME' },
        organizationId,
      );
      await this.addMessage(
        conversation.id,
        'AGENT',
        `I queued the ${QA_WORKFLOW} workflow for ${input.storyKey}. Browser runs and defect ` +
          'filing will each wait for approval.',
        organizationId,
      );
      return {
        mode: 'GENERIC_RUNTIME' as const,
        agentRun: { id: run.id, threadId: run.threadId, status: run.status },
      };
    });
  }

  createQaRun(
    input: {
      employeeId: string;
      conversationId: string;
      storyKey: string;
      targetUrl: string;
      plan: string[];
      approvalSummary: string;
    },
    organizationId = ORGANIZATION_ID,
    allowDemo = true,
  ): Promise<{
    run: QaRun;
    approval: Approval;
    agentRun: { id: string; threadId: string; status: AgentRunStatus };
  }> {
    return this.db.tenant(organizationId, async () => {
      const conversation = await this.getConversation(input.conversationId, organizationId);
      if (conversation.employeeId !== input.employeeId) throw new Error('CONVERSATION_FORBIDDEN');
      const manifest =
        conversation.agentId !== AGENT_ID || !allowDemo
          ? await this.getManifest(conversation.agentId, organizationId, input.employeeId)
          : null;
      const runId = randomUUID();
      const approvalId = randomUUID();
      const timestamp = now();
      await this.db.run(
        `INSERT INTO approvals
         (id, organization_id, requested_by, action, resource_type, resource_id, risk, summary, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        approvalId,
        organizationId,
        input.employeeId,
        'qa.execute_playwright',
        'qa_run',
        runId,
        'MEDIUM',
        input.approvalSummary,
        'PENDING',
        timestamp,
      );
      await this.db.run(
        `INSERT INTO qa_runs
         (id, organization_id, employee_id, conversation_id, story_key, target_url, status, plan, approval_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId,
        organizationId,
        input.employeeId,
        input.conversationId,
        input.storyKey,
        input.targetUrl,
        'AWAITING_APPROVAL',
        JSON.stringify(input.plan),
        approvalId,
        timestamp,
      );
      await this.audit(
        input.employeeId,
        'qa_run.requested',
        'qa_run',
        runId,
        {
          storyKey: input.storyKey,
        },
        organizationId,
      );
      // ADR 0003: the generic run is written in the same transaction as the legacy record.
      const agentRun = await this.execution.recordLegacyQaRun({
        organizationId,
        employeeId: input.employeeId,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        qaRunId: runId,
        approvalId,
        storyKey: input.storyKey,
        targetUrl: input.targetUrl,
        plan: input.plan,
        approvalSummary: input.approvalSummary,
        manifest,
      });
      return {
        run: await this.getQaRun(runId, organizationId),
        approval: await this.getApproval(approvalId, organizationId),
        agentRun,
      };
    });
  }

  listApprovals(organizationId = ORGANIZATION_ID, employeeId?: string): Promise<Approval[]> {
    return this.db.tenant(organizationId, async () => {
      await this.actions.expireDue(Date.now(), organizationId);
      const rows = await this.db.all(
        `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
                risk, summary, status, decided_by, decided_at, created_at, run_id, step_id, expires_at
         FROM approvals WHERE organization_id = ? ORDER BY created_at DESC, seq DESC`,
        organizationId,
      );
      return rows
        .map((row) => this.mapApproval(row))
        .filter((item) => !employeeId || item.requestedBy === employeeId);
    });
  }

  async decideApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'PENDING'>,
    actorId: string,
    organizationId = ORGANIZATION_ID,
  ): Promise<Approval> {
    const timestamp = now();
    // Expiry commits on its own, so an expired approval stays expired even though the decision fails.
    await this.actions.expireDue(Date.now(), organizationId);
    return this.db.tenant(organizationId, async () => {
      // Read inside the write transaction so concurrent decisions cannot both succeed.
      const approval = await this.getApproval(id, organizationId);
      if (approval.requestedBy === actorId) throw new Error('SELF_APPROVAL_FORBIDDEN');
      if (approval.status === 'EXPIRED') throw new Error('APPROVAL_EXPIRED');
      if (approval.status !== 'PENDING') throw new Error('APPROVAL_ALREADY_DECIDED');
      await this.db.run(
        'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND organization_id = ?',
        status,
        actorId,
        timestamp,
        id,
        organizationId,
      );
      const runStatus: QaRunStatus = status === 'APPROVED' ? 'READY' : 'REJECTED';
      await this.db.run(
        'UPDATE qa_runs SET status = ? WHERE approval_id = ? AND organization_id = ?',
        runStatus,
        id,
        organizationId,
      );
      await this.execution.onApprovalDecided(organizationId, id, status, actorId);
      await this.audit(
        actorId,
        `approval.${status.toLowerCase()}`,
        'approval',
        id,
        {
          resourceId: approval.resourceId,
        },
        organizationId,
      );
      return this.getApproval(id, organizationId);
    });
  }

  private async getQaRun(id: string, organizationId: string): Promise<QaRun> {
    const row = await this.db.get(
      `SELECT id, organization_id, employee_id, conversation_id, story_key, target_url,
              status, plan, approval_id, created_at FROM qa_runs WHERE id = ? AND organization_id = ?`,
      id,
      organizationId,
    );
    if (!row) throw new Error('QA_RUN_NOT_FOUND');
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      employeeId: String(row['employee_id']),
      conversationId: String(row['conversation_id']),
      storyKey: String(row['story_key']),
      targetUrl: String(row['target_url']),
      status: String(row['status']) as QaRunStatus,
      plan: JSON.parse(String(row['plan'])) as string[],
      approvalId: String(row['approval_id']),
      createdAt: String(row['created_at']),
    };
  }

  private async getApproval(id: string, organizationId: string): Promise<Approval> {
    const row = await this.db.get(
      `SELECT id, organization_id, requested_by, action, resource_type, resource_id,
              risk, summary, status, decided_by, decided_at, created_at, run_id, step_id, expires_at FROM approvals WHERE id = ? AND organization_id = ?`,
      id,
      organizationId,
    );
    if (!row) throw new Error('APPROVAL_NOT_FOUND');
    return this.mapApproval(row);
  }

  /** The local demo tenant (demo mode only); platform scope, idempotent. */
  private seed(): Promise<void> {
    return this.db.platform(async () => {
      await this.db.run(
        'INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        ORGANIZATION_ID,
        'Agents Foundry',
        'agents-foundry',
      );
      await this.db.run(
        `INSERT INTO employees
         (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        EMPLOYEE_ID,
        ORGANIZATION_ID,
        'QA Engineer',
        'qa.engineer@agents-foundry.local',
        'EMPLOYEE',
        'QA',
      );
      await this.db.run(
        'INSERT INTO employees (id, organization_id, display_name, email, role, team) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        'admin_demo',
        ORGANIZATION_ID,
        'Demo Admin',
        'admin@agents-foundry.local',
        'ADMIN',
        'Administration',
      );
      await this.db.run(
        `INSERT INTO agents
         (id, organization_id, name, department, team, status, capabilities)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        AGENT_ID,
        ORGANIZATION_ID,
        'QA Engineer Agent',
        'Engineering',
        'QA',
        'ACTIVE',
        JSON.stringify(['jira.read', 'repository.read', 'qa.plan', 'qa.execute_playwright']),
      );
    });
  }

  /** Tenant audit trail; joins the caller's transaction (platform flows included). */
  private audit(
    actorId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    metadata: object,
    organizationId = ORGANIZATION_ID,
  ): Promise<void> {
    return this.db.tenant(organizationId, async () => {
      await this.db.run(
        `INSERT INTO audit_events
         (id, organization_id, actor_id, event_type, resource_type, resource_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        organizationId,
        actorId,
        eventType,
        resourceType,
        resourceId,
        JSON.stringify(metadata),
        now(),
      );
    });
  }

  private mapEmployee(row: Row): Employee {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      displayName: String(row['display_name']),
      email: String(row['email']),
      role: String(row['role']) as Employee['role'],
      team: String(row['team']),
    };
  }

  private async mapAgent(row: Row): Promise<AgentDefinition> {
    const assignment = await this.db.get<{ employee_id: string }>(
      'SELECT employee_id FROM agent_manifests WHERE agent_id = ? AND organization_id = ?',
      String(row['id']),
      String(row['organization_id']),
    );
    return {
      ...(assignment ? { employeeId: assignment.employee_id } : {}),
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      name: String(row['name']),
      department: String(row['department']),
      team: String(row['team']),
      status: String(row['status']) as AgentDefinition['status'],
      capabilities: JSON.parse(String(row['capabilities'])) as string[],
    };
  }

  private mapConversation(row: Row): Conversation {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      employeeId: String(row['employee_id']),
      agentId: String(row['agent_id']),
      title: String(row['title']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }

  private mapMessage(row: Row): ConversationMessage {
    return {
      id: String(row['id']),
      conversationId: String(row['conversation_id']),
      author: String(row['author']) as ConversationMessage['author'],
      content: String(row['content']),
      createdAt: String(row['created_at']),
    };
  }

  private mapApproval(row: Row): Approval {
    return {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      requestedBy: String(row['requested_by']),
      action: String(row['action']),
      resourceType: String(row['resource_type']),
      resourceId: String(row['resource_id']),
      risk: String(row['risk']) as Approval['risk'],
      summary: String(row['summary']),
      status: String(row['status']) as Approval['status'],
      ...(row['decided_by'] ? { decidedBy: String(row['decided_by']) } : {}),
      ...(row['decided_at'] ? { decidedAt: String(row['decided_at']) } : {}),
      createdAt: String(row['created_at']),
      ...(row['expires_at'] ? { expiresAt: String(row['expires_at']) } : {}),
      ...(row['run_id'] ? { runId: String(row['run_id']) } : {}),
      ...(row['step_id'] ? { stepId: String(row['step_id']) } : {}),
    };
  }
}
