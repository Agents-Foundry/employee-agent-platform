import pg from 'pg';

/** A login role; the password is only ever sent inside a quoted literal. */
export interface LoginRole {
  name: string;
  password: string;
}

export interface BootstrapOptions {
  database: string;
  /** Owns the schema and runs migrations. Row-level security is forced on it too. */
  owner: LoginRole;
  /** The API's tenant connection: member of af_tenant, never BYPASSRLS. */
  tenant: LoginRole;
  /** The API's platform connection: member of af_platform, BYPASSRLS. */
  platform: LoginRole;
}

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function name(value: string): string {
  if (!NAME.test(value)) throw new Error('INVALID_DATABASE_IDENTIFIER');
  return pg.escapeIdentifier(value);
}

/**
 * Creates the roles and database for one deployment (ADR 0018). Needs a superuser connection
 * (`DATABASE_ADMIN_URL`), because only a superuser can grant BYPASSRLS. Idempotent: existing
 * roles get their attributes and passwords reset; an existing database is kept.
 */
export async function bootstrapDatabase(adminUrl: string, options: BootstrapOptions) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const role = async (roleName: string, attributes: string) => {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [roleName]);
      await admin.query(
        `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${name(roleName)} ${attributes}`,
      );
    };
    const login = (item: LoginRole, attributes: string) =>
      role(item.name, `LOGIN ${attributes} PASSWORD ${pg.escapeLiteral(item.password)}`);
    await role('af_tenant', 'NOLOGIN NOINHERIT NOBYPASSRLS');
    await role('af_platform', 'NOLOGIN NOINHERIT NOBYPASSRLS');
    await login(options.owner, 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS');
    await login(options.tenant, 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT');
    await login(options.platform, 'NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS INHERIT');
    await admin.query(`GRANT af_tenant TO ${name(options.tenant.name)}`);
    await admin.query(`GRANT af_platform TO ${name(options.platform.name)}`);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
      options.database,
    ]);
    if (!exists.rowCount) {
      await admin.query(
        `CREATE DATABASE ${name(options.database)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' OWNER ${name(options.owner.name)}`,
      );
    }
    await admin.query(
      `REVOKE ALL ON DATABASE ${name(options.database)} FROM PUBLIC;
       GRANT CONNECT ON DATABASE ${name(options.database)} TO ${name(options.tenant.name)}, ${name(options.platform.name)}`,
    );
  } finally {
    await admin.end();
  }
  // The public schema belongs to the database owner; nobody else may create objects in it.
  const database = new URL(adminUrl);
  database.pathname = `/${options.database}`;
  const client = new pg.Client({ connectionString: database.href });
  await client.connect();
  try {
    await client.query(`ALTER SCHEMA public OWNER TO ${name(options.owner.name)};
      REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  } finally {
    await client.end();
  }
}

/** Connection URL for a role on the admin URL's server. */
export function roleUrl(adminUrl: string, database: string, role: LoginRole): string {
  const url = new URL(adminUrl);
  url.username = role.name;
  url.password = role.password;
  url.pathname = `/${database}`;
  return url.href;
}

/** Clones a database from a template (tests); no session may be connected to the template. */
export async function cloneDatabase(
  adminUrl: string,
  database: string,
  template: string,
  owner: string,
): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${name(database)} TEMPLATE ${name(template)} OWNER ${name(owner)}`,
    );
  } finally {
    await admin.end();
  }
}

/** Drops a database created for tests. */
export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name(database)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
