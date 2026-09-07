// Minimal type-safe dependency-injection container (singleton scoped per kernel).

export type Factory<T = unknown> = (container: Container) => T | Promise<T>;

type Registration<T = unknown> =
  | { kind: 'value'; value: T }
  | { kind: 'factory'; factory: Factory<T>; instance?: T; resolved: boolean };

/**
 * Raised when a caller attempts to replace or remove a SEALED container
 * binding. Sealing exists for authoritative security bindings (R1/A-01): a
 * boundary that can be swapped out by a later registration, by module
 * ordering, or by a test override is not authoritative.
 */
export class SealedBindingError extends Error {
  constructor(token: string, operation: string) {
    super(
      `Container: token "${token}" is SEALED and cannot be ${operation}. ` +
        'Sealed bindings are authoritative security bindings; substituting them is a fail-open defect.',
    );
    this.name = 'SealedBindingError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class Container {
  private registry = new Map<string, Registration>();
  /** Tokens whose binding is immutable for the lifetime of this container. */
  private sealed = new Set<string>();

  private assertMutable(token: string, operation: string): void {
    if (this.sealed.has(token)) throw new SealedBindingError(token, operation);
  }

  /** Register a pre-built value. */
  registerValue<T>(token: string, value: T): this {
    this.assertMutable(token, 'replaced');
    this.registry.set(token, { kind: 'value', value });
    return this;
  }

  /**
   * Register a value that can never be replaced, overridden, or cleared.
   * Used for the authoritative A-01 authorization boundary so that neither
   * module registration order, a second non-authoritative gate, nor a test
   * fixture can substitute for it.
   */
  registerSealed<T>(token: string, value: T): this {
    this.assertMutable(token, 're-sealed');
    this.registry.set(token, { kind: 'value', value });
    this.sealed.add(token);
    return this;
  }

  /** Is this token bound with an immutable (sealed) registration? */
  isSealed(token: string): boolean {
    return this.sealed.has(token);
  }

  /** Register a factory that will be lazily invoked once on first `resolve`. */
  registerFactory<T>(token: string, factory: Factory<T>): this {
    this.assertMutable(token, 'replaced');
    this.registry.set(token, { kind: 'factory', factory, resolved: false });
    return this;
  }

  /** Replace a registration (useful in tests). Sealed tokens refuse. */
  override<T>(token: string, value: T): this {
    this.assertMutable(token, 'overridden');
    return this.registerValue(token, value);
  }

  /** Remove a single registration. Sealed tokens refuse. */
  unregister(token: string): boolean {
    this.assertMutable(token, 'unregistered');
    return this.registry.delete(token);
  }

  /** Is a token registered? */
  has(token: string): boolean {
    return this.registry.has(token);
  }

  /** Resolve a token; throws if not registered. Factories are cached (singleton). */
  async resolve<T = unknown>(token: string): Promise<T> {
    const reg = this.registry.get(token);
    if (!reg) {
      throw new Error(`Container: no binding for token "${token}"`);
    }
    if (reg.kind === 'value') return reg.value as T;
    if (reg.resolved) return reg.instance as T;
    const value = await reg.factory(this);
    reg.instance = value;
    reg.resolved = true;
    return value as T;
  }

  /** Synchronous resolve — only works for values or already-resolved factories. */
  resolveSync<T = unknown>(token: string): T {
    const reg = this.registry.get(token);
    if (!reg) throw new Error(`Container: no binding for token "${token}"`);
    if (reg.kind === 'value') return reg.value as T;
    if (reg.resolved) return reg.instance as T;
    throw new Error(
      `Container: token "${token}" is an async factory and hasn't been resolved yet. Use await container.resolve(...) first.`,
    );
  }

  /**
   * Remove all registrations (used by tests). Sealed security bindings are
   * NOT removable: clearing a container must not be a route to a runtime with
   * no authorization boundary.
   */
  clear(): void {
    for (const token of [...this.registry.keys()]) {
      if (!this.sealed.has(token)) this.registry.delete(token);
    }
  }
}
