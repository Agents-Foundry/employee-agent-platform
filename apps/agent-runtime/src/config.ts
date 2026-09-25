import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeConfig {
  controlPlaneUrl: string;
  runtimeId: string;
  privateKey: KeyObject;
  manifestVerificationKey: string;
  stateDir: string;
  pollIntervalMs: number;
  concurrency: number;
  enableScriptedModel: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('CONFIG_INVALID');
  return parsed;
}

/** Fails at startup on any missing or malformed setting; there are no insecure defaults. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const stateDir = env['AGENT_RUNTIME_STATE_DIR'] ?? '.data/agent-runtime';
  const privateKey = createPrivateKey(
    readFileSync(required(env, 'AGENT_RUNTIME_PRIVATE_KEY_PATH')),
  );
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('RUNTIME_KEY_ED25519_REQUIRED');
  return {
    controlPlaneUrl: required(env, 'CONTROL_PLANE_URL'),
    runtimeId: required(env, 'AGENT_RUNTIME_ID'),
    privateKey,
    manifestVerificationKey: required(env, 'MANIFEST_VERIFICATION_KEY'),
    stateDir,
    pollIntervalMs: bounded(env['AGENT_RUNTIME_POLL_MS'], 2000, 100, 60_000),
    concurrency: bounded(env['AGENT_RUNTIME_CONCURRENCY'], 4, 1, 64),
    enableScriptedModel: env['AGENT_RUNTIME_ENABLE_SCRIPTED_MODEL'] === 'true',
  };
}

export const statePaths = (stateDir: string) => ({
  checkpoints: join(stateDir, 'checkpoints'),
  artifacts: join(stateDir, 'artifacts'),
});
