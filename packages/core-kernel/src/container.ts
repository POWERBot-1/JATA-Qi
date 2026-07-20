// Minimal type-safe dependency-injection container (singleton scoped per kernel).

export type Factory<T = unknown> = (container: Container) => T | Promise<T>;

type Registration<T = unknown> =
  | { kind: 'value'; value: T }
  | { kind: 'factory'; factory: Factory<T>; instance?: T; resolved: boolean };

export class Container {
  private registry = new Map<string, Registration>();

  /** Register a pre-built value. */
  registerValue<T>(token: string, value: T): this {
    this.registry.set(token, { kind: 'value', value });
    return this;
  }

  /** Register a factory that will be lazily invoked once on first `resolve`. */
  registerFactory<T>(token: string, factory: Factory<T>): this {
    this.registry.set(token, { kind: 'factory', factory, resolved: false });
    return this;
  }

  /** Replace a registration (useful in tests). */
  override<T>(token: string, value: T): this {
    return this.registerValue(token, value);
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

  /** Remove all registrations (used by tests). */
  clear(): void {
    this.registry.clear();
  }
}
