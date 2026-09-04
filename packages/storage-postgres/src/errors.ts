// P-01 storage-postgres error taxonomy. Every error maps to a defined safe
// state; nothing here grants authority or fabricates an outcome.

/** Configuration is missing/incomplete or a connection cannot be established. */
export class PostgresStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresStorageError';
  }
}

/** The on-disk/in-database schema version is not compatible with this code. */
export class IncompatibleStorageSchemaError extends PostgresStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleStorageSchemaError';
  }
}

/** A transaction could not be committed (rolled back safely). */
export class PostgresTransactionError extends PostgresStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresTransactionError';
  }
}

/** Raised when the driver is not usable because configuration is missing. */
export class PostgresConfigError extends PostgresStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresConfigError';
  }
}

/** T-01: tenant isolation violation at the storage boundary. */
export class PostgresTenantIsolationError extends PostgresStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresTenantIsolationError';
  }
}

/** T-01: a generic driver error. */
export class PostgresDriverError extends PostgresStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresDriverError';
  }
}
