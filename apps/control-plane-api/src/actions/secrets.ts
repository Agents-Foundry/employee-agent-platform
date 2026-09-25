import { readFileSync } from 'node:fs';
import { secretReferencePattern } from '../../../../packages/contracts/src/actions.js';

/**
 * Resolves `secret://<name>` references at the moment of use. Implementations must scope
 * names to the owning organization, never log values, and return null when unresolved;
 * callers fail closed (`SECRET_UNRESOLVED`).
 */
export interface SecretResolver {
  resolve(organizationId: string, reference: string): string | null;
}

function nameOf(reference: string): string | null {
  return secretReferencePattern.test(reference) ? reference.slice('secret://'.length) : null;
}

/**
 * Operator-managed JSON file `{ "<organizationId>": { "<name>": "<value>" } }` at
 * `CONNECTOR_SECRETS_PATH`, read on each use so rotation needs no restart. A stand-in for a
 * managed vault; the reference format and per-tenant scoping stay the same.
 */
export class FileSecretStore implements SecretResolver {
  constructor(private readonly path: string | undefined = process.env['CONNECTOR_SECRETS_PATH']) {}

  resolve(organizationId: string, reference: string): string | null {
    const name = nameOf(reference);
    if (!name || !this.path) return null;
    try {
      const store = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      const scoped = store[organizationId];
      if (!scoped || typeof scoped !== 'object' || !Object.hasOwn(scoped, name)) return null;
      const value = (scoped as Record<string, unknown>)[name];
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
}

export class MemorySecretStore implements SecretResolver {
  private readonly values = new Map<string, string>();

  set(organizationId: string, name: string, value: string): void {
    this.values.set(`${organizationId}\u0000${name}`, value);
  }

  resolve(organizationId: string, reference: string): string | null {
    const name = nameOf(reference);
    return name ? (this.values.get(`${organizationId}\u0000${name}`) ?? null) : null;
  }
}
