import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import pg from 'pg';
import type { ExecutionOperation } from '@agents-foundry/contracts';
import {
  POSTGRES_MIGRATIONS,
  SCHEMA_VERSION,
} from '../../../apps/control-plane-api/src/db/migrate.js';
import {
  secretProviderFromEnvironment,
  type SecretProvider,
} from '../../../apps/control-plane-api/src/secrets/secret-broker.js';
import {
  artifactStoreFromEnvironment,
  type ArtifactStore,
} from '../../../apps/control-plane-api/src/artifacts/artifact-store.js';
import { ManifestSigner } from '../../../apps/control-plane-api/src/manifest-signing.js';
import {
  RuntimeIdentityRegistry,
  servesOrganization,
} from '../../../apps/control-plane-api/src/runtime/runtime-identity.js';
import { GrantVerifier } from '../../../apps/execution-runtime/src/grant-verifier.js';
import {
  defaultEgressProxyDirectory,
  egressProxyArgs,
} from '../../../apps/execution-runtime/src/providers/container-provider.js';
import { canonicalManifest } from '../../contracts/src/manifest.js';
import {
  EXECUTION_GRANT_KIND,
  executionPaths,
  type ExecutionGrantPayload,
} from '../../contracts/src/execution-runtime/v1/protocol.js';
import { telemetryFromEnvironment, type ConfiguredTelemetry } from '../../telemetry/src/index.js';

/**
 * `npm run pilot:validate` (ADR 0039): checks a deployed pilot environment without changing
 * customer data. Every check uses the configuration the services themselves read, through the
 * same factories, so it validates what will run. Nothing a check touches is printed: details
 * are written here, errors are reduced to codes, and the report is scrubbed of every secret
 * value the run handled before it leaves the process.
 */

export type CheckStatus = 'passed' | 'failed' | 'skipped';
export type Scope = 'control-plane' | 'execution-host';
/** Operational proofs this command can produce (ADR 0038, ADR 0039). */
export type ValidationProof = 'vault-live' | 'object-store-live' | 'telemetry-live';

export interface CheckResult {
  id: string;
  title: string;
  scope: Scope;
  status: CheckStatus;
  detail: string;
  durationMs: number;
}

export interface ValidationReport {
  kind: 'pilot-validate';
  version: 1;
  generatedAt: string;
  commit: string | null;
  environment: string;
  scopes: Scope[];
  checks: CheckResult[];
  proofs: Record<ValidationProof, 'passed' | 'failed' | 'not-run'>;
  passed: boolean;
  /** How many secret values had to be removed from the report; always 0 unless a bug leaks. */
  redactions: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ValidationDependencies {
  env: NodeJS.ProcessEnv;
  /** Runs one read-only statement on a connection opened with `url`. */
  query(url: string, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  secretProvider(env: NodeJS.ProcessEnv): SecretProvider;
  objectStore(env: NodeJS.ProcessEnv): ArtifactStore;
  telemetry(env: NodeJS.ProcessEnv): ConfiguredTelemetry;
  docker(args: string[], timeoutMs: number): Promise<CommandResult>;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  commit: string | null;
}

/** Feature flags a pilot needs, each of which must be set to exactly `true`. */
export const PILOT_FLAGS = [
  'GENERIC_AGENT_RUNTIME_ENABLED',
  'AGENT_MANIFEST_V2_ISSUANCE_ENABLED',
  'QA_GENERIC_RUNTIME_ENABLED',
  'ARTIFACTS_REQUIRE_MANAGED',
] as const;

/** Development conveniences that must be off in a pilot, and what "off" means for each. */
export const DEVELOPMENT_FALLBACKS: readonly {
  variable: string;
  safe: (value: string | undefined) => boolean;
  why: string;
}[] = [
  { variable: 'AUTH_MODE', safe: (v) => v === 'password' || v === 'google', why: 'demo sign-in' },
  { variable: 'SECRET_PROVIDER', safe: (v) => v === 'vault', why: 'file secret store' },
  { variable: 'CONNECTOR_SECRETS_PATH', safe: (v) => !v, why: 'plain-file connector secrets' },
  { variable: 'ARTIFACT_STORE', safe: (v) => v === 's3', why: 'local artifact directory' },
  { variable: 'TELEMETRY_EXPORTER', safe: (v) => v === 'otlp', why: 'telemetry not exported' },
  { variable: 'EXECUTION_PROVIDER', safe: (v) => v === 'container', why: 'unsandboxed execution' },
  {
    variable: 'EXECUTION_ALLOW_UNSANDBOXED',
    safe: (v) => v !== 'true',
    why: 'unsandboxed fallback',
  },
  {
    variable: 'EXECUTION_ALLOW_UNRESTRICTED_EGRESS',
    safe: (v) => v !== 'true',
    why: 'egress without the allow-list',
  },
  { variable: 'EXECUTION_EGRESS_PROXY', safe: (v) => v !== 'false', why: 'egress proxy disabled' },
  {
    variable: 'EXECUTION_ALLOW_FILE_REPOSITORIES',
    safe: (v) => v !== 'true',
    why: 'file:// repositories',
  },
  {
    variable: 'AGENT_RUNTIME_ENABLE_SCRIPTED_MODEL',
    safe: (v) => v !== 'true',
    why: 'scripted test model',
  },
  { variable: 'AGENT_RUNTIME_ENV_MODEL_KEYS', safe: (v) => v !== 'true', why: 'model keys in env' },
  {
    variable: 'AGENT_RUNTIME_CHECKPOINT_STORE',
    safe: (v) => !v || v === 'control-plane',
    why: 'local checkpoints',
  },
  {
    variable: 'AGENT_RUNTIME_ARTIFACT_STORE',
    safe: (v) => !v || v === 'control-plane',
    why: 'local artifacts',
  },
  { variable: 'NODE_ENV', safe: (v) => v === 'production', why: 'not a production build' },
];

const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

/** An error as a code. Messages from drivers and stores are never repeated. */
export function errorCode(error: unknown): string {
  const message = (error as Error | null)?.message ?? '';
  if (CODE.test(message)) return message;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return 'UNREACHABLE';
  if (code === '28P01' || code === '28000') return 'AUTHENTICATION_FAILED';
  if (code === '3D000') return 'DATABASE_NOT_FOUND';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE_${code}`;
  if (code === 'ENOENT') return 'FILE_NOT_FOUND';
  if ((error as Error | null)?.name === 'TimeoutError') return 'TIMEOUT';
  return 'UNEXPECTED_ERROR';
}

interface Check {
  id: string;
  title: string;
  scope: Scope;
  run(context: Context): Promise<string>;
}

class CheckFailed extends Error {}
const fail = (detail: string): never => {
  throw new CheckFailed(detail);
};

interface Context {
  env: NodeJS.ProcessEnv;
  deps: ValidationDependencies;
  /** Records a value that must never appear in output. */
  secret(value: string | undefined | null): void;
  required(name: string): string;
  organizationId(): string;
}

const password = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
};

const tenantTables = `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
  WHERE n.nspname='public' AND c.relkind='r'`;

export const CHECKS: readonly Check[] = [
  {
    id: 'database.connectivity',
    title: 'PostgreSQL accepts the tenant and platform connections',
    scope: 'control-plane',
    async run({ deps, required }) {
      for (const name of ['DATABASE_URL', 'DATABASE_PLATFORM_URL']) {
        const rows = await deps.query(required(name), 'SELECT 1 AS ok');
        if (rows[0]?.['ok'] !== 1) fail(`${name} did not answer`);
      }
      return 'Both roles connected.';
    },
  },
  {
    id: 'database.migrations',
    title: 'The schema is at this release’s migration version',
    scope: 'control-plane',
    async run({ deps, required }) {
      const rows = await deps.query(
        required('DATABASE_PLATFORM_URL'),
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      );
      const versions = rows.map((row) => Number(row['version']));
      const latest = versions.at(-1) ?? 0;
      if (latest > SCHEMA_VERSION)
        fail(`Database is at ${latest}, newer than this release (${SCHEMA_VERSION}).`);
      const sums = new Map(rows.map((row) => [Number(row['version']), String(row['checksum'])]));
      const missing = POSTGRES_MIGRATIONS.filter((m) => !sums.has(m.version)).map((m) => m.version);
      if (missing.length) fail(`Migrations not applied: ${missing.join(', ')}.`);
      const changed = POSTGRES_MIGRATIONS.filter(
        (m) =>
          sums.get(m.version) !==
          createHash('sha256').update(m.sql.replace(/\r\n/g, '\n')).digest('hex'),
      ).map((m) => m.version);
      if (changed.length)
        fail(`Migrations recorded with a different checksum: ${changed.join(', ')}.`);
      return `Schema version ${SCHEMA_VERSION}, ${POSTGRES_MIGRATIONS.length} migrations verified.`;
    },
  },
  {
    id: 'database.roles',
    title: 'The tenant and platform database roles exist and are used',
    scope: 'control-plane',
    async run({ deps, required }) {
      const roles = await deps.query(
        required('DATABASE_PLATFORM_URL'),
        "SELECT rolname FROM pg_roles WHERE rolname IN ('af_tenant','af_platform') ORDER BY rolname",
      );
      if (roles.length !== 2) fail('Role af_tenant or af_platform is missing.');
      const member = async (name: string, role: string) => {
        const [row] = await deps.query(
          required(name),
          'SELECT pg_has_role(current_user, $1, $2) AS member',
          [role, 'MEMBER'],
        );
        if (row?.['member'] !== true) fail(`${name} does not connect as a member of ${role}.`);
      };
      await member('DATABASE_URL', 'af_tenant');
      await member('DATABASE_PLATFORM_URL', 'af_platform');
      const [same] = await deps.query(required('DATABASE_URL'), 'SELECT current_user AS name');
      const [other] = await deps.query(
        required('DATABASE_PLATFORM_URL'),
        'SELECT current_user AS name',
      );
      if (same?.['name'] === other?.['name']) fail('Tenant and platform URLs use the same login.');
      return 'af_tenant and af_platform exist; each URL logs in as its own member.';
    },
  },
  {
    id: 'database.row-level-security',
    title: 'The tenant role cannot bypass row-level security',
    scope: 'control-plane',
    async run({ deps, required }) {
      const tenant = required('DATABASE_URL');
      const [attributes] = await deps.query(
        tenant,
        `SELECT r.rolsuper, r.rolbypassrls,
          EXISTS (SELECT 1 FROM pg_roles g WHERE pg_has_role(r.oid, g.oid, 'MEMBER')
                  AND (g.rolsuper OR g.rolbypassrls)) AS inherits
         FROM pg_roles r WHERE r.rolname=current_user`,
      );
      if (!attributes) fail('The tenant login was not found.');
      if (attributes!['rolsuper'] || attributes!['rolbypassrls'] || attributes!['inherits'])
        fail('The tenant login is a superuser or can bypass row-level security.');
      const tables = await deps.query(required('DATABASE_PLATFORM_URL'), tenantTables);
      const weak = tables
        .filter((table) => !table['relrowsecurity'] || !table['relforcerowsecurity'])
        .map((table) => String(table['relname']));
      if (!tables.length) fail('No tenant tables found.');
      if (weak.length) fail(`Row-level security is not forced on: ${weak.join(', ')}.`);
      // Without an organization in scope the tenant role sees nothing, whatever exists.
      const [seen] = await deps.query(tenant, 'SELECT count(*)::int AS n FROM agent_runs');
      const [all] = await deps.query(
        required('DATABASE_PLATFORM_URL'),
        'SELECT count(*)::int AS n FROM agent_runs',
      );
      if (Number(seen?.['n']) !== 0) fail('The tenant role reads runs without an organization.');
      return `Forced on ${tables.length} tenant tables; unscoped tenant reads return nothing (${Number(all?.['n']) > 0 ? 'checked against existing rows' : 'no rows exist to compare'}).`;
    },
  },
  {
    id: 'vault.health-secret',
    title: 'Vault resolves the dedicated health-check secret',
    scope: 'control-plane',
    async run({ env, deps, secret, organizationId }) {
      if (env['SECRET_PROVIDER'] !== 'vault') fail('SECRET_PROVIDER is not vault.');
      secret(readOptional(env['VAULT_TOKEN_PATH']));
      const name = env['PILOT_HEALTHCHECK_SECRET']?.trim() || 'pilot-healthcheck';
      const value = await deps.secretProvider(env).resolve(organizationId(), name);
      secret(value);
      if (!value)
        fail(`The health-check secret ${name} does not exist for the pilot organization.`);
      return `Resolved secret://${name} for the pilot organization; its value is not shown.`;
    },
  },
  {
    id: 'object-store.round-trip',
    title: 'The object store stores, returns and deletes a temporary object',
    scope: 'control-plane',
    async run({ env, deps, secret }) {
      if (env['ARTIFACT_STORE'] !== 's3') fail('ARTIFACT_STORE is not s3.');
      for (const value of Object.values(readJson(env['ARTIFACT_S3_CREDENTIALS_PATH'])))
        secret(typeof value === 'string' ? value : null);
      const store = deps.objectStore(env);
      // Under its own prefix, never a key a run could use (those start with an organization).
      const key = `pilot-validate/${randomUUID()}/probe`;
      const content = randomBytes(256);
      await store.put(key, content, 'application/octet-stream');
      try {
        const back = await store.get(key);
        if (!back || !back.equals(content)) fail('The object came back different.');
      } finally {
        await store.delete(key);
      }
      if ((await store.get(key)) !== null) fail('The object was still there after delete.');
      return 'Put, read back byte for byte, deleted and confirmed gone.';
    },
  },
  {
    id: 'telemetry.otlp',
    title: 'The OTLP collector accepts a synthetic health trace',
    scope: 'control-plane',
    async run({ env, deps, secret }) {
      if (env['TELEMETRY_EXPORTER'] !== 'otlp') fail('TELEMETRY_EXPORTER is not otlp.');
      for (const value of Object.values(readJson(env['TELEMETRY_OTLP_HEADERS_PATH'])))
        secret(typeof value === 'string' ? value : null);
      const { telemetry } = deps.telemetry(env);
      const runId = `pilot-validate-${randomUUID()}`;
      telemetry.span({
        runId,
        name: 'pilot.validate',
        subject: 'run',
        id: runId,
        startTimeMs: Date.now() - 1,
      });
      await telemetry.flush();
      const dropped = (await telemetry.metrics.collect())
        .find((family) => family.name === 'af_telemetry_dropped_total')
        ?.points.reduce((sum, point) => sum + point.value, 0);
      if (dropped) fail('The collector refused or did not answer the trace.');
      return `Collector accepted trace for af.run.id=${runId}.`;
    },
  },
  {
    id: 'runtimes.identities',
    title: 'Agent and execution runtime identities are registered for the pilot organization',
    scope: 'control-plane',
    async run({ env, required, organizationId }) {
      const path = required('AGENT_RUNTIME_IDENTITIES_PATH');
      const configs = readJson(path) as unknown as { id?: unknown; role?: unknown }[];
      const previous = process.env['AGENT_RUNTIME_IDENTITIES_PATH'];
      process.env['AGENT_RUNTIME_IDENTITIES_PATH'] = path;
      let registry: RuntimeIdentityRegistry;
      try {
        registry = RuntimeIdentityRegistry.fromEnvironment();
      } finally {
        if (previous === undefined) delete process.env['AGENT_RUNTIME_IDENTITIES_PATH'];
        else process.env['AGENT_RUNTIME_IDENTITIES_PATH'] = previous;
      }
      const serving = (Array.isArray(configs) ? configs : [])
        .map((config) => registry.get(String(config.id)))
        .filter((identity) => identity && servesOrganization(identity, organizationId()));
      const agents = serving.filter((identity) => identity!.role === 'agent').length;
      const executors = serving.filter((identity) => identity!.role === 'execution').length;
      if (!agents) fail('No agent runtime identity serves the pilot organization.');
      if (!executors) fail('No execution runtime identity serves the pilot organization.');
      void env;
      return `${agents} agent and ${executors} execution runtime identities serve the pilot organization.`;
    },
  },
  {
    id: 'signing.manifest-key',
    title: 'The manifest signing key is configured',
    scope: 'control-plane',
    async run({ required, secret }) {
      const path = required('MANIFEST_SIGNING_KEY_PATH');
      // Never ManifestSigner.fromFile: it would create a key, and the check would pass.
      if (!existsSync(path)) fail('MANIFEST_SIGNING_KEY_PATH names no file.');
      const pem = readFileSync(path, 'utf8');
      secret(pem);
      for (const line of pem.split(/\r?\n/)) if (!line.startsWith('-----')) secret(line);
      const signer = new ManifestSigner(pem);
      if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0)
        fail('The signing key file is readable by other users.');
      return `Ed25519 key ${signer.verificationKey.keyId.slice(0, 16)}… is configured.`;
    },
  },
  {
    id: 'signing.execution-verifies',
    title: 'The execution runtime’s pinned key verifies the control plane’s grants',
    scope: 'execution-host',
    async run({ required, secret }) {
      const pem = readFileSync(required('MANIFEST_SIGNING_KEY_PATH'), 'utf8');
      secret(pem);
      const signer = new ManifestSigner(pem);
      const verifier = new GrantVerifier(required('EXECUTION_GRANT_VERIFICATION_KEY'));
      if (verifier.keyId !== signer.verificationKey.keyId)
        fail('EXECUTION_GRANT_VERIFICATION_KEY is not the control plane’s signing key.');
      // A synthetic grant: signed and verified here, never sent anywhere.
      const operation: ExecutionOperation = {
        kind: 'git.checkout',
        repositoryUrl: 'https://pilot-validate.invalid/repository.git',
        ref: 'main',
        path: 'repo',
      };
      const now = Date.now();
      const payload: ExecutionGrantPayload = {
        kind: EXECUTION_GRANT_KIND,
        grantId: randomUUID(),
        requestId: randomUUID(),
        action: 'pilot.validate',
        correlation: {
          organizationId: 'pilot-validate',
          employeeId: 'pilot-validate',
          agentId: 'pilot-validate',
          threadId: 'pilot-validate',
          runId: 'pilot-validate',
          stepId: 'pilot-validate',
          toolCallId: 'pilot-validate',
        },
        operationKind: operation.kind,
        operationDigest: createHash('sha256').update(canonicalManifest(operation)).digest('hex'),
        isolation: 'sandboxed',
        limits: {
          timeoutMs: 1000,
          cpuMillis: 100,
          memoryMb: 64,
          maxProcesses: 1,
          network: { mode: 'NONE', allowedHosts: [] },
        },
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      };
      verifier.verify(signer.signExecutionGrant(payload), operation, now);
      const forged = new ManifestSigner(
        generateKeyPairSync('ed25519')
          .privateKey.export({ type: 'pkcs8', format: 'pem' })
          .toString(),
      ).signExecutionGrant(payload);
      let refused = false;
      try {
        verifier.verify({ ...forged, keyId: verifier.keyId }, operation, now);
      } catch {
        refused = true;
      }
      if (!refused) fail('A grant signed by another key was accepted.');
      return 'A control-plane grant verifies and a forged one is refused.';
    },
  },
  {
    id: 'execution.reachable',
    title: 'The execution runtime answers and runs a sandboxed provider',
    scope: 'execution-host',
    async run({ deps, required }) {
      const url = new URL(executionPaths.health, required('EXECUTION_RUNTIME_URL'));
      const response = await deps.fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) fail(`The health endpoint answered HTTP ${response.status}.`);
      const health = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (health['status'] !== 'ok') fail('The execution runtime is not healthy.');
      if (health['provider'] !== 'container' || health['isolation'] !== 'sandboxed')
        fail('The execution runtime is not running the sandboxed container provider.');
      return 'Healthy, with the sandboxed container provider.';
    },
  },
  {
    id: 'sandbox.images',
    title: 'The sandbox, Playwright and egress proxy images are present',
    scope: 'execution-host',
    async run({ env, deps, required }) {
      if (env['EXECUTION_PROVIDER'] !== 'container') fail('EXECUTION_PROVIDER is not container.');
      const images = [
        ...new Set([
          required('EXECUTION_SANDBOX_IMAGE'),
          required('EXECUTION_PLAYWRIGHT_IMAGE'),
          env['EXECUTION_EGRESS_PROXY_IMAGE']?.trim() || required('EXECUTION_SANDBOX_IMAGE'),
        ]),
      ];
      const missing: string[] = [];
      for (const image of images) {
        const inspected = await deps.docker(
          ['image', 'inspect', '--format', '{{.Id}}', image],
          30_000,
        );
        if (inspected.exitCode !== 0) missing.push(image);
      }
      if (missing.length) fail(`Not present (images are never pulled): ${missing.join(', ')}.`);
      return `${images.length} images present.`;
    },
  },
  {
    id: 'sandbox.egress-proxy',
    title: 'The egress proxy starts',
    scope: 'execution-host',
    async run({ env, deps, required }) {
      if (env['EXECUTION_EGRESS_PROXY'] === 'false') fail('The egress proxy is disabled.');
      const directory = env['EXECUTION_EGRESS_PROXY_DIR']?.trim() || defaultEgressProxyDirectory();
      if (!directory) fail('EXECUTION_EGRESS_PROXY_NOT_FOUND');
      const name = `af-validate-egress-${randomUUID()}`;
      const started = await deps.docker(
        egressProxyArgs({
          name,
          image: env['EXECUTION_EGRESS_PROXY_IMAGE']?.trim() || required('EXECUTION_SANDBOX_IMAGE'),
          directory: directory!,
          allowedHosts: ['pilot-validate.invalid'],
          user: '1000:1000',
        }),
        30_000,
      );
      try {
        if (started.exitCode !== 0) fail('The egress proxy container did not start.');
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const logs = await deps.docker(['logs', name], 10_000);
          if (logs.stdout.includes('"event":"ready"'))
            return 'Started locked down, reported ready, and was removed.';
          await deps.sleep(200);
        }
        return fail('The egress proxy never reported ready.');
      } finally {
        await deps.docker(['rm', '--force', name], 30_000);
      }
    },
  },
  {
    id: 'model.credential',
    title: 'The pilot organization has an active model credential that resolves',
    scope: 'control-plane',
    async run({ env, deps, required, secret, organizationId }) {
      const provider = required('PILOT_MODEL_PROVIDER');
      const [row] = await deps.query(
        required('DATABASE_PLATFORM_URL'),
        `SELECT secret_ref, status FROM organization_model_credentials
         WHERE organization_id=$1 AND provider=$2`,
        [organizationId(), provider],
      );
      if (!row) fail(`No ${provider} credential is configured for the pilot organization.`);
      if (row!['status'] !== 'ACTIVE') fail(`The ${provider} credential is disabled.`);
      if (env['SECRET_PROVIDER'] !== 'vault') fail('SECRET_PROVIDER is not vault.');
      const reference = String(row!['secret_ref']);
      const value = await deps
        .secretProvider(env)
        .resolve(organizationId(), reference.slice('secret://'.length));
      secret(value);
      if (!value) fail(`${reference} does not resolve.`);
      return `Active ${provider} credential ${reference} resolves; its value is not shown.`;
    },
  },
  {
    id: 'flags.pilot',
    title: 'Feature flags the pilot needs are explicitly enabled',
    scope: 'control-plane',
    async run({ env }) {
      const off = PILOT_FLAGS.filter((flag) => env[flag] !== 'true');
      if (off.length) fail(`Not set to true: ${off.join(', ')}.`);
      return `${PILOT_FLAGS.join(', ')} are true.`;
    },
  },
  {
    id: 'flags.development-fallbacks',
    title: 'Dangerous development fallbacks are disabled',
    scope: 'control-plane',
    async run({ env }) {
      const unsafe = DEVELOPMENT_FALLBACKS.filter((item) => !item.safe(env[item.variable]?.trim()));
      if (unsafe.length) fail(unsafe.map((item) => `${item.variable} (${item.why})`).join('; '));
      if (env['VAULT_ADDR'] && !env['VAULT_ADDR'].startsWith('https://'))
        fail('VAULT_ADDR is not HTTPS.');
      return `${DEVELOPMENT_FALLBACKS.length} fallbacks checked; none is enabled.`;
    },
  },
];

const PROOF_CHECKS: Record<ValidationProof, readonly string[]> = {
  'vault-live': ['vault.health-secret', 'model.credential'],
  'object-store-live': ['object-store.round-trip'],
  'telemetry-live': ['telemetry.otlp'],
};

function readOptional(path: string | undefined): string | null {
  if (!path?.trim()) return null;
  try {
    return readFileSync(path.trim(), 'utf8').trim();
  } catch {
    return null;
  }
}

function readJson(path: string | undefined): Record<string, unknown> {
  const text = readOptional(path);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function defaultDependencies(env: NodeJS.ProcessEnv = process.env): ValidationDependencies {
  return {
    env,
    async query(url, sql, params = []) {
      const client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10_000,
      });
      client.on('error', () => undefined);
      await client.connect();
      try {
        // Read-only: a validation can never change data, even through a mistake here.
        await client.query('BEGIN READ ONLY');
        const result = await client.query(sql, params);
        await client.query('ROLLBACK');
        return result.rows as Record<string, unknown>[];
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    secretProvider: (environment) =>
      secretProviderFromEnvironment(
        {
          resolve: () => {
            throw new Error('SECRET_PROVIDER_NOT_VAULT');
          },
        },
        environment,
      ),
    objectStore: (environment) => artifactStoreFromEnvironment(environment),
    telemetry: (environment) => telemetryFromEnvironment('pilot-validate', environment),
    docker: (args, timeoutMs) =>
      new Promise((resolve) =>
        execFile(
          env['DOCKER_EXECUTABLE'] || 'docker',
          args,
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) =>
            resolve({
              exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
              stdout: String(stdout),
              stderr: String(stderr),
            }),
        ),
      ),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    commit: null,
  };
}

export async function validatePilot(
  deps: ValidationDependencies,
  scopes: readonly Scope[] = ['control-plane', 'execution-host'],
): Promise<ValidationReport> {
  const env = deps.env;
  const secrets = new Set<string>();
  const secret = (value: string | undefined | null) => {
    if (value && value.length >= 4) secrets.add(value);
  };
  for (const name of ['DATABASE_URL', 'DATABASE_PLATFORM_URL', 'DATABASE_MIGRATION_URL'])
    if (env[name]) secret(password(env[name]!));
  const context: Context = {
    env,
    deps,
    secret,
    required(name) {
      const value = env[name]?.trim();
      if (!value) fail(`${name} is not set.`);
      return value!;
    },
    organizationId() {
      const value = env['PILOT_ORGANIZATION_ID']?.trim();
      if (!value || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value))
        fail('PILOT_ORGANIZATION_ID is not set to an organization identifier.');
      return value!;
    },
  };
  const checks: CheckResult[] = [];
  for (const check of CHECKS) {
    const started = Date.now();
    const base = { id: check.id, title: check.title, scope: check.scope };
    if (!scopes.includes(check.scope)) {
      checks.push({
        ...base,
        status: 'skipped',
        detail: 'Not in the scope of this run.',
        durationMs: 0,
      });
      continue;
    }
    try {
      const detail = await check.run(context);
      checks.push({ ...base, status: 'passed', detail, durationMs: Date.now() - started });
    } catch (error) {
      checks.push({
        ...base,
        status: 'failed',
        detail: error instanceof CheckFailed ? error.message : errorCode(error),
        durationMs: Date.now() - started,
      });
    }
  }
  const proofs = Object.fromEntries(
    Object.entries(PROOF_CHECKS).map(([proof, ids]) => {
      const results = ids.map((id) => checks.find((check) => check.id === id)!.status);
      return [
        proof,
        results.includes('failed')
          ? 'failed'
          : results.every((status) => status === 'passed')
            ? 'passed'
            : 'not-run',
      ];
    }),
  ) as ValidationReport['proofs'];
  const report: ValidationReport = {
    kind: 'pilot-validate',
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: deps.commit,
    environment: env['PILOT_ENVIRONMENT']?.trim() || 'pilot',
    scopes: [...scopes],
    checks,
    proofs,
    passed: checks.every((check) => check.status !== 'failed'),
    redactions: 0,
  };
  return scrub(report, secrets);
}

/** Removes every known secret value from a report; counts what it had to remove. */
export function scrub<T extends { redactions: number }>(report: T, secrets: Iterable<string>): T {
  let text = JSON.stringify(report);
  let redactions = 0;
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) {
    const encoded = JSON.stringify(value).slice(1, -1);
    for (const form of new Set([value, encoded])) {
      const parts = text.split(form);
      redactions += parts.length - 1;
      text = parts.join('[redacted]');
    }
  }
  const clean = JSON.parse(text) as T;
  clean.redactions = redactions;
  return clean;
}

export function summarize(report: ValidationReport): string {
  const mark = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' } as const;
  const lines = [
    `Pilot validation for ${report.environment}${report.commit ? ` at ${report.commit.slice(0, 12)}` : ''}`,
    ...report.checks.map(
      (check) => `  ${mark[check.status]}  ${check.title}\n        ${check.detail}`,
    ),
    `Operational proofs: ${Object.entries(report.proofs)
      .map(([proof, status]) => `${proof}=${status}`)
      .join(', ')}`,
    report.passed
      ? 'Every check in scope passed. No customer data was changed.'
      : 'Validation FAILED. No customer data was changed.',
  ];
  return `${lines.join('\n')}\n`;
}
