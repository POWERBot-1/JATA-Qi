// Typed async event bus supporting wildcards and once-listeners.

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

interface Listener {
  readonly handler: EventHandler;
  readonly once: boolean;
}

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private wildcardListeners = new Set<Listener>();

  /** Subscribe to an event name. Returns an unsubscribe function. */
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.addListener(event, { handler: handler as EventHandler, once: false });
  }

  /** Subscribe once; automatically removed after first dispatch. */
  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.addListener(event, { handler: handler as EventHandler, once: true });
  }

  /** Remove a specific handler (all occurrences). */
  off(event: string, handler: EventHandler): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of [...set]) {
      if (l.handler === handler) set.delete(l);
    }
    if (set.size === 0) this.listeners.delete(event);
  }

  /** Emit an event, awaiting every handler (including wildcards), in insertion order. */
  async emit<T = unknown>(event: string, payload: T): Promise<void> {
    const snapshot: Listener[] = [];

    const named = this.listeners.get(event);
    if (named) {
      for (const l of named) snapshot.push(l);
    }
    for (const l of this.wildcardListeners) snapshot.push(l);

    // Clean up 'once' listeners *before* invocation so re-emit during handler is fine.
    for (const l of snapshot) {
      if (l.once) {
        if (named) named.delete(l);
        this.wildcardListeners.delete(l);
      }
    }
    if (named && named.size === 0) this.listeners.delete(event);

    // Invoke each handler in its own safe microtask so a throw in one does
    // not prevent siblings from running and does not leak an unhandled rejection.
    const errors: unknown[] = [];
    await Promise.all(
      snapshot.map(async (l) => {
        try {
          await l.handler(payload);
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    for (const err of errors) {
      // Write to stderr without triggering Node's uncaughtException detection.
      process.stderr.write(`[EventBus] handler error for "${event}": ${String((err as Error)?.message ?? err)}\n`);
    }
  }

  /** Subscribe to every event. */
  onAny<T = unknown>(handler: EventHandler<T>): () => void {
    const l: Listener = { handler: handler as EventHandler, once: false };
    this.wildcardListeners.add(l);
    return () => this.wildcardListeners.delete(l);
  }

  /** Total listener count (named + wildcard), useful for tests. */
  listenerCount(event?: string): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    let n = this.wildcardListeners.size;
    for (const v of this.listeners.values()) n += v.size;
    return n;
  }

  /** Remove every listener. Used by kernel shutdown and tests. */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
  }

  private addListener(event: string, listener: Listener): () => void {
    if (event === '*' || event === '**') {
      this.wildcardListeners.add(listener);
      return () => this.wildcardListeners.delete(listener);
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(event);
    };
  }
}
