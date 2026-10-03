import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneDatabase } from '../src/database.js';
import { hashToken } from '../src/auth.js';
import { hashPassword } from '../src/passwords.js';
import { MemoryArtifactStore } from '../src/artifacts/artifact-store.js';
import { ManifestSigner } from '../src/manifest-signing.js';
import { telemetryFromEnvironment } from '../../../packages/telemetry/src/index.js';
import {
  CHECKS,
  defaultDependencies,
  scrub,
  summarize,
  validatePilot,
  type CommandResult,
  type ValidationDependencies,
} from '../../../packages/operations/src/validate.js';
import { runtimeKeyPair } from './runtime-helpers.js';
import { testStore, type TestStore } from './support/database.js';

const HEALTH_VALUE = 'health-check-value-0b5e2d71';
const MODEL_KEY = 'sk-pilot-model-key-7f3a9c11e2d4';
const COLLECTOR_TOKEN = 'collector-bearer-token-55aa';
const S3_SECRET = 's3-secret-access-key-90ff';

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });

describe('pilot validation', () => {
  let stores: TestStore;
  let db: ControlPlaneDatabase;
  let organizationId: string;
  let directory: string;
  let signer: ManifestSigner;
  let collector: { server: Server; url: string };
  let execution: { server: Server; url: string };
  let traces: string[];
  let collectorStatus: number;
  let docker: string[][];
  let objects: MemoryArtifactStore;
  let vault: Map<string, string>;

  beforeEach(async () => {
    stores = await testStore();
    db = await ControlPlaneDatabase.open({
      seedDemo: false,
      store: stores.store,
      signer: new ManifestSigner(),
      artifactStore: new MemoryArtifactStore(),
    });
    const org = await db.createCustomer(
      { name: 'Pilot', slug: 'pilot' },
      { displayName: 'Admin', email: 'admin@pilot.example', team: 'Admin' },
    );
    await db.acceptInvitation(
      hashToken(org.token),
      await hashPassword('a long test-only password'),
    );
    organizationId = org.organizationId;
    await db.modelCredentials.set(
      { id: org.employeeId, organizationId, role: 'ADMIN' },
      'anthropic',
      { secretRef: 'secret://model-key' },
    );
    directory = mkdtempSync(join(tmpdir(), 'af-validate-'));
    const pem = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    writeFileSync(join(directory, 'signing.pem'), pem, { mode: 0o600 });
    signer = new ManifestSigner(pem);
    writeFileSync(
      join(directory, 'identities.json'),
      JSON.stringify([
        {
          id: 'agent-1',
          publicKeySpki: runtimeKeyPair().spki,
          organizations: [organizationId],
          runtimeProfiles: ['standard-agent'],
        },
        {
          id: 'execution-1',
          role: 'execution',
          publicKeySpki: runtimeKeyPair().spki,
          organizations: ['*'],
          runtimeProfiles: ['standard-agent'],
        },
      ]),
    );
    writeFileSync(join(directory, 'vault-token'), 'hvs.vault-token-value-1234');
    writeFileSync(
      join(directory, 's3.json'),
      JSON.stringify({ accessKeyId: 'AKIAPILOTVALIDATE01', secretAccessKey: S3_SECRET }),
    );
    writeFileSync(
      join(directory, 'otlp-headers.json'),
      JSON.stringify({ authorization: `Bearer ${COLLECTOR_TOKEN}` }),
    );
    traces = [];
    collectorStatus = 200;
    collector = await listen((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        if (request.headers.authorization === `Bearer ${COLLECTOR_TOKEN}`) traces.push(body);
        response.writeHead(collectorStatus).end('{}');
      });
    });
    execution = await listen((request, response) => {
      response.writeHead(request.url === '/execution/v1/health' ? 200 : 404, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ status: 'ok', provider: 'container', isolation: 'sandboxed' }));
    });
    docker = [];
    objects = new MemoryArtifactStore();
    vault = new Map([
      [`${organizationId}/pilot-healthcheck`, HEALTH_VALUE],
      [`${organizationId}/model-key`, MODEL_KEY],
    ]);
  });

  afterEach(async () => {
    collector.server.close();
    execution.server.close();
    rmSync(directory, { recursive: true, force: true });
    await stores.drop();
  });

  const environment = (): NodeJS.ProcessEnv => ({
    PILOT_ENVIRONMENT: 'pilot-test',
    PILOT_ORGANIZATION_ID: organizationId,
    PILOT_MODEL_PROVIDER: 'anthropic',
    DATABASE_URL: stores.urls.tenant,
    DATABASE_PLATFORM_URL: stores.urls.platform,
    SECRET_PROVIDER: 'vault',
    VAULT_ADDR: 'https://vault.pilot.example:8200',
    VAULT_KV_MOUNT: 'agents-foundry',
    VAULT_TOKEN_PATH: join(directory, 'vault-token'),
    ARTIFACT_STORE: 's3',
    ARTIFACT_S3_CREDENTIALS_PATH: join(directory, 's3.json'),
    TELEMETRY_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    TELEMETRY_OTLP_HEADERS_PATH: join(directory, 'otlp-headers.json'),
    AGENT_RUNTIME_IDENTITIES_PATH: join(directory, 'identities.json'),
    MANIFEST_SIGNING_KEY_PATH: join(directory, 'signing.pem'),
    EXECUTION_GRANT_VERIFICATION_KEY: signer.verificationKey.publicKeySpki,
    EXECUTION_RUNTIME_URL: execution.url,
    EXECUTION_PROVIDER: 'container',
    EXECUTION_SANDBOX_IMAGE: 'agents-foundry/sandbox:pilot',
    EXECUTION_PLAYWRIGHT_IMAGE: 'agents-foundry/playwright:pilot',
    EXECUTION_EGRESS_PROXY_DIR: directory,
    AUTH_MODE: 'password',
    NODE_ENV: 'production',
    GENERIC_AGENT_RUNTIME_ENABLED: 'true',
    AGENT_MANIFEST_V2_ISSUANCE_ENABLED: 'true',
    QA_GENERIC_RUNTIME_ENABLED: 'true',
    ARTIFACTS_REQUIRE_MANAGED: 'true',
  });

  const dependencies = (
    env: NodeJS.ProcessEnv,
    answer: (args: string[]) => CommandResult = (args) => ({
      exitCode: 0,
      stdout: args[0] === 'logs' ? '{"event":"ready","port":3128}\n' : 'sha256:abc\n',
      stderr: '',
    }),
  ): ValidationDependencies => ({
    ...defaultDependencies(env),
    secretProvider: () => ({
      id: 'vault',
      resolve: async (organization, name) => vault.get(`${organization}/${name}`) ?? null,
    }),
    objectStore: () => objects,
    telemetry: (env) => telemetryFromEnvironment('pilot-validate', env),
    docker: async (args) => {
      docker.push(args);
      return answer(args);
    },
    sleep: async () => undefined,
    commit: 'abc123',
  });

  const tableCounts = async () =>
    Promise.all(
      (
        await stores.store.platform(() =>
          stores.store.all<{ tablename: string }>(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
          ),
        )
      ).map(async ({ tablename }) => [
        tablename,
        (await stores.store.platform(() =>
          stores.store.get<{ n: number }>(`SELECT count(*)::int AS n FROM "${tablename}"`),
        ))!.n,
      ]),
    );

  it('passes a correctly configured pilot environment, changes nothing and prints no secret', async () => {
    const before = await tableCounts();
    const report = await validatePilot(dependencies(environment()));
    expect(
      report.checks.filter((check) => check.status !== 'passed').map((c) => [c.id, c.detail]),
    ).toEqual([]);
    expect(report.checks.map((check) => check.id)).toEqual(CHECKS.map((check) => check.id));
    expect(report).toMatchObject({
      kind: 'pilot-validate',
      passed: true,
      commit: 'abc123',
      environment: 'pilot-test',
      proofs: { 'vault-live': 'passed', 'object-store-live': 'passed', 'telemetry-live': 'passed' },
      redactions: 0,
    });
    // The collector received the synthetic trace, with its credential.
    expect(traces.join('')).toContain('pilot.validate');
    // The object store holds nothing afterwards, and no table changed.
    expect(objects.objects.size).toBe(0);
    expect(await tableCounts()).toEqual(before);
    // The egress proxy started locked down and was removed; nothing was pulled.
    const proxy = docker.find((args) => args[0] === 'run')!;
    expect(proxy).toEqual(
      expect.arrayContaining(['--cap-drop', 'ALL', '--read-only', '--pull', 'never']),
    );
    expect(docker.at(-1)).toEqual(['rm', '--force', proxy[proxy.indexOf('--name') + 1]]);
    expect(docker.some((args) => args.includes('pull'))).toBe(false);
    const printed = JSON.stringify(report) + summarize(report);
    for (const secret of [
      HEALTH_VALUE,
      MODEL_KEY,
      COLLECTOR_TOKEN,
      S3_SECRET,
      'af-test-app',
      'af-test-platform',
      'hvs.vault-token-value-1234',
    ])
      expect(printed).not.toContain(secret);
    expect(summarize(report)).toContain('Every check in scope passed.');
  }, 60_000);

  it('fails closed on a misconfigured environment and names what is wrong, not its values', async () => {
    const env = {
      ...environment(),
      // The tenant URL logs in as the platform role, which bypasses row-level security.
      DATABASE_URL: stores.urls.platform,
      SECRET_PROVIDER: 'development',
      CONNECTOR_SECRETS_PATH: join(directory, 'secrets.json'),
      ARTIFACT_STORE: 'local',
      AUTH_MODE: 'demo',
      EXECUTION_ALLOW_UNSANDBOXED: 'true',
      QA_GENERIC_RUNTIME_ENABLED: 'yes',
      MANIFEST_SIGNING_KEY_PATH: join(directory, 'missing.pem'),
      EXECUTION_GRANT_VERIFICATION_KEY: runtimeKeyPair().spki,
      PILOT_MODEL_PROVIDER: 'openai',
    };
    collectorStatus = 503;
    vault.delete(`${organizationId}/pilot-healthcheck`);
    const report = await validatePilot(
      dependencies(env, (args) =>
        args[0] === 'image'
          ? { exitCode: 1, stdout: '', stderr: 'No such image' }
          : { exitCode: 0, stdout: '', stderr: '' },
      ),
    );
    const failed = Object.fromEntries(
      report.checks.filter((check) => check.status === 'failed').map((c) => [c.id, c.detail]),
    );
    expect(Object.keys(failed).sort()).toEqual(
      [
        'database.roles',
        'database.row-level-security',
        'vault.health-secret',
        'object-store.round-trip',
        'telemetry.otlp',
        'signing.manifest-key',
        'signing.execution-verifies',
        'sandbox.images',
        'sandbox.egress-proxy',
        'model.credential',
        'flags.pilot',
        'flags.development-fallbacks',
      ].sort(),
    );
    expect(failed['database.row-level-security']).toContain('bypass row-level security');
    expect(failed['flags.pilot']).toBe('Not set to true: QA_GENERIC_RUNTIME_ENABLED.');
    expect(failed['flags.development-fallbacks']).toContain('AUTH_MODE (demo sign-in)');
    expect(failed['flags.development-fallbacks']).toContain('EXECUTION_ALLOW_UNSANDBOXED');
    expect(failed['sandbox.images']).toContain('agents-foundry/playwright:pilot');
    expect(failed['model.credential']).toContain('No openai credential');
    expect(report).toMatchObject({
      passed: false,
      proofs: { 'vault-live': 'failed', 'object-store-live': 'failed', 'telemetry-live': 'failed' },
    });
    expect(summarize(report)).toContain('Validation FAILED. No customer data was changed.');
    expect(JSON.stringify(report)).not.toContain(MODEL_KEY);
  }, 60_000);

  it('runs only the checks in scope and claims no proof it did not run', async () => {
    const report = await validatePilot(dependencies(environment()), ['execution-host']);
    expect(
      report.checks.filter((check) => check.status === 'passed').map((check) => check.id),
    ).toEqual([
      'signing.execution-verifies',
      'execution.reachable',
      'sandbox.images',
      'sandbox.egress-proxy',
    ]);
    expect(report.proofs).toEqual({
      'vault-live': 'not-run',
      'object-store-live': 'not-run',
      'telemetry-live': 'not-run',
    });
    expect(report.passed).toBe(true);
  }, 60_000);

  it('removes any secret value that reaches a report, and counts it', () => {
    const leaked = scrub({ redactions: 0, detail: `token ${MODEL_KEY} and "${MODEL_KEY}"` }, [
      MODEL_KEY,
    ]);
    expect(leaked).toEqual({ redactions: 2, detail: 'token [redacted] and "[redacted]"' });
  });
});
