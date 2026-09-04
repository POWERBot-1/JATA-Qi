// P-01 storage-postgres configuration.
//
// Configuration is externalized (never hard-coded). Credentials are read from
// a connection string / individual fields supplied by the composition root
// (env, config provider) — never committed. Missing configuration fails
// closed with PostgresConfigError rather than silently falling back.

import type pg from 'pg';
import { PostgresConfigError } from './errors.js';

export const STORAGE_POSTGRES_SCHEMA_VERSION = 1;
/** Recognized table shape kinds backed by this driver. */
export type PgKind = 'collection' | 'namespace' | 'blob';

export interface PostgresDriverConfig {
  /**
   * Standard PostgreSQL connection string (e.g.
   * `postgres://user:pass@host:5432/db`). When supplied it wins over the
   * individual host/port/database/user/password fields.
   */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** Connection pool sizing. */
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Optional externally-managed pool (tests / composition roots). */
  pool?: pg.Pool;
  /** A short identifier logged in pg_stat_activity. */
  applicationName?: string;
  /**
   * When true and no connection details resolve, throw on first use instead of
   * silently defaulting to a localhost attempt. Strongly recommended in
   * production composition.
   */
  requireExplicitConfig?: boolean;
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Resolve a pg.PoolConfig from driver options. Never returns undefined. */
export function resolvePoolConfig(
  opts: PostgresDriverConfig,
  env: NodeJS.ProcessEnv = process.env,
): pg.PoolConfig {
  if (opts.pool) return {};
  const connectionString = opts.connectionString ?? env.JATAQI_PG_CONNECTION_STRING;
  const host = opts.host ?? env.PGHOST ?? (present(opts.connectionString) ? undefined : '127.0.0.1');
  const port = opts.port ?? (env.PGPORT ? Number(env.PGPORT) : 5432);
  const database = opts.database ?? env.PGDATABASE ?? env.JATAQI_PG_DATABASE;
  const user = opts.user ?? env.PGUSER ?? env.JATAQI_PG_USER;
  const password = opts.password ?? env.PGPASSWORD ?? env.JATAQI_PG_PASSWORD;
  const max = opts.max ?? 10;
  const idleTimeoutMillis = opts.idleTimeoutMillis ?? 10_000;
  const connectionTimeoutMillis = opts.connectionTimeoutMillis ?? 5_000;

  if (!connectionString) {
    const hasAnyCredential = present(user) || present(password);
    const hasAnyTarget = present(database) || present(host);
    if (opts.requireExplicitConfig === true || (!hasAnyTarget && !hasAnyCredential)) {
      throw new PostgresConfigError(
        'No PostgreSQL connection configuration was supplied (missing connection string and missing database/host/user). ' +
          'Set JATAQI_PG_CONNECTION_STRING (or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD) or pass options explicitly. Failing closed.',
      );
    }
  }

  if (connectionString) {
    // Discrete host/port/etc. are ignored when a connection string is used.
    return {
      connectionString,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    };
  }
  return {
    host,
    port,
    database,
    user,
    password,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  };
}
