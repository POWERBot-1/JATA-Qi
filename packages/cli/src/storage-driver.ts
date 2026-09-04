// R-01 durable storage driver resolution at the composition root.
//
// ARCHITECTURAL NOTE — why this lives in @jataqi/cli and NOT in @jataqi/storage:
// `@jataqi/storage-postgres` depends on `@jataqi/storage`. If `@jataqi/storage`
// resolved the Postgres driver by name it would depend on its own dependent and
// create a cycle, inverting the layering the P-01 audit verified as clean.
// Driver selection is therefore a *composition-root* concern: the CLI knows
// about concrete drivers, the storage abstraction does not. Dependency
// direction stays storage-postgres -> storage, never the reverse.
//
// This module activates no credentials. It reads a connection string supplied
// by the operator's environment and fails closed when it is absent.

import type { IStorageDriver } from '@jataqi/storage';

/** Storage driver selector accepted by the CLI/composition root. */
export type StorageDriverName = 'memory' | 'filesystem' | 'postgres';

export const DURABLE_DRIVER_NAMES: readonly StorageDriverName[] = ['postgres'];

/** True when the selector denotes authoritative production persistence. */
export function isDurableDriverName(name: string): boolean {
  return (DURABLE_DRIVER_NAMES as readonly string[]).includes(name);
}

export class StorageDriverResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageDriverResolutionError';
  }
}

/**
 * Resolve a concrete driver instance for a durable driver selector.
 *
 * Returns `undefined` for the built-in development drivers ('memory',
 * 'filesystem') so the caller keeps passing them to StorageModule by name —
 * default behaviour is deliberately untouched.
 *
 * For 'postgres' the @jataqi/storage-postgres driver is imported dynamically
 * and constructed with `requireExplicitConfig: true`, so a missing connection
 * string throws PostgresConfigError rather than silently attempting localhost.
 * Credentials come only from the operator environment
 * (JATAQI_PG_CONNECTION_STRING or the standard PG* variables).
 */
export async function resolveStorageDriver(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IStorageDriver | undefined> {
  if (name === 'memory' || name === 'filesystem' || name === 'fs') return undefined;
  if (name !== 'postgres') {
    throw new StorageDriverResolutionError(
      `Unknown storage driver "${name}". Supported: memory, filesystem, postgres.`,
    );
  }

  let mod: typeof import('@jataqi/storage-postgres');
  try {
    mod = await import('@jataqi/storage-postgres');
  } catch (error) {
    throw new StorageDriverResolutionError(
      'STORAGE_DRIVER=postgres was requested but @jataqi/storage-postgres could not be loaded ' +
        `(${(error as Error).message}). Install the workspace and retry. Failing closed.`,
    );
  }

  const connectionString = env.JATAQI_PG_CONNECTION_STRING;
  // requireExplicitConfig makes the driver throw PostgresConfigError when no
  // connection details resolve — never a silent localhost fallback.
  return new mod.PostgresDriver({
    connectionString,
    applicationName: env.JATAQI_PG_APPLICATION_NAME ?? 'jataqi-host',
    requireExplicitConfig: true,
  });
}

/**
 * Redact credentials from a connection string for safe logging.
 * `postgres://user:secret@host:5432/db` -> `postgres://user:***@host:5432/db`
 */
export function redactConnectionString(value: string | undefined): string {
  if (!value) return '(none)';
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(unparseable connection string; redacted)';
  }
}
