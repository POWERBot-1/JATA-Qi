// Shared error base class for JATA Qi so callers can `instanceof` across packages.

export class JataQiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'JataQiError';
    this.code = code;
    this.details = details;
    // Restore prototype chain for TS/Node when transpiling to ES5+.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ModuleNotFoundError extends JataQiError {
  constructor(id: string) {
    super('MODULE_NOT_FOUND', `Module "${id}" not found`, { id });
    this.name = 'ModuleNotFoundError';
  }
}

export class DependencyError extends JataQiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('DEPENDENCY_ERROR', message, details);
    this.name = 'DependencyError';
  }
}

export class ConfigError extends JataQiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIG_ERROR', message, details);
    this.name = 'ConfigError';
  }
}
