// Typed async event bus supporting wildcards and once-listeners.
//
// F-01 adds a backward-compatible enveloped delivery path alongside the
// legacy payload-only path:
//
//   * Legacy `on/once/emit/onAny` behavior is UNCHANGED: handlers receive
//     exactly the payload that was emitted.
//   * `onEnveloped/onAnyEnveloped/emitEnveloped` carry unified `EventEnvelope`
//     records together with the bus topic, so wildcard consumers can classify
//     every event from the envelope alone (closing the F-01 two-plane split).
//   * Legacy `emit` additionally bridges a best-effort envelope to enveloped
//     listeners (flagged `legacy: true` for plain payloads), so unmigrated
//     producers remain classifiable by topic without changing their payloads.
//   * `emitEnveloped` delivers the envelope to enveloped listeners and
//     `opts.legacyPayload ?? envelope` to legacy listeners, so migrated
//     producers can preserve the exact legacy payload shape during the
//     migration window with a single emission (no duplicate delivery).

import {
  toEnvelopedDelivery,
  type EventEnvelope,
} from './event-envelope.js';

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/** Handler receiving the bus topic plus the unified envelope. */
export type EnvelopedHandler = (topic: string, envelope: EventEnvelope) => void | Promise<void>;

interface Listener {
  readonly handler: EventHandler;
  readonly once: boolean;
}

interface EnvelopedListener {
  readonly handler: EnvelopedHandler;
  readonly once: boolean;
}

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private wildcardListeners = new Set<Listener>();
  private envelopedListeners = new Map<string, Set<EnvelopedListener>>();
  private wildcardEnvelopedListeners = new Set<EnvelopedListener>();

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
    // Legacy delivery is byte-identical to the pre-F-01 behavior.
    await this.deliverLegacy(event, payload);
    // Bridge: enveloped listeners also observe a best-effort envelope so
    // unmigrated producers stay classifiable by topic. Plain payloads are
    // flagged `legacy: true`; commercial-like payloads lift without the flag.
    // The bridge must never break legacy delivery: any bridging failure is
    // contained to stderr (fail-closed for the new path only).
    try {
      await this.deliverEnveloped(event, toEnvelopedDelivery(event, payload));
    } catch (err) {
      process.stderr.write(`[EventBus] envelope bridge failed for "${event}": ${String((err as Error)?.message ?? err)}\n`);
    }
  }

  /** Subscribe to every event. */
  onAny<T = unknown>(handler: EventHandler<T>): () => void {
    const l: Listener = { handler: handler as EventHandler, once: false };
    this.wildcardListeners.add(l);
    return () => this.wildcardListeners.delete(l);
  }

  /**
   * Emit a first-class unified envelope. Enveloped listeners receive
   * `(topic, envelope)`; legacy listeners receive
   * `opts.legacyPayload ?? envelope` so a migrated producer preserves the
   * exact legacy payload shape with a single emission.
   */
  async emitEnveloped(
    event: string,
    envelope: EventEnvelope,
    opts: { legacyPayload?: unknown } = {},
  ): Promise<void> {
    await this.deliverLegacy(event, opts.legacyPayload === undefined ? envelope : opts.legacyPayload);
    await this.deliverEnveloped(event, envelope);
  }

  /** Subscribe to one topic with enveloped delivery. Returns an unsubscribe function. */
  onEnveloped(event: string, handler: EnvelopedHandler): () => void {
    return this.addEnvelopedListener(event, { handler, once: false });
  }

  /** Subscribe once with enveloped delivery. */
  onceEnveloped(event: string, handler: EnvelopedHandler): () => void {
    return this.addEnvelopedListener(event, { handler, once: true });
  }

  /** Subscribe to every enveloped delivery. The topic is always provided. */
  onAnyEnveloped(handler: EnvelopedHandler): () => void {
    const l: EnvelopedListener = { handler, once: false };
    this.wildcardEnvelopedListeners.add(l);
    return () => this.wildcardEnvelopedListeners.delete(l);
  }

  /** Total listener count (named + wildcard), useful for tests. Legacy listeners only. */
  listenerCount(event?: string): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    let n = this.wildcardListeners.size;
    for (const v of this.listeners.values()) n += v.size;
    return n;
  }

  /** Total enveloped-listener count (named + wildcard), useful for tests. */
  envelopedListenerCount(event?: string): number {
    if (event) return this.envelopedListeners.get(event)?.size ?? 0;
    let n = this.wildcardEnvelopedListeners.size;
    for (const v of this.envelopedListeners.values()) n += v.size;
    return n;
  }

  /** Remove every listener. Used by kernel shutdown and tests. */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
    this.envelopedListeners.clear();
    this.wildcardEnvelopedListeners.clear();
  }

  private async deliverLegacy(event: string, payload: unknown): Promise<void> {
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

    await this.invokeSafely(event, payload, snapshot);
  }

  private async deliverEnveloped(event: string, envelope: EventEnvelope): Promise<void> {
    const snapshot: EnvelopedListener[] = [];

    const named = this.envelopedListeners.get(event);
    if (named) {
      for (const l of named) snapshot.push(l);
    }
    for (const l of this.wildcardEnvelopedListeners) snapshot.push(l);

    for (const l of snapshot) {
      if (l.once) {
        if (named) named.delete(l);
        this.wildcardEnvelopedListeners.delete(l);
      }
    }
    if (named && named.size === 0) this.envelopedListeners.delete(event);

    const errors: unknown[] = [];
    await Promise.all(
      snapshot.map(async (l) => {
        try {
          await l.handler(event, envelope);
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    for (const err of errors) {
      process.stderr.write(`[EventBus] enveloped handler error for "${event}": ${String((err as Error)?.message ?? err)}\n`);
    }
  }

  private async invokeSafely(event: string, payload: unknown, snapshot: Listener[]): Promise<void> {
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

  private addEnvelopedListener(event: string, listener: EnvelopedListener): () => void {
    if (event === '*' || event === '**') {
      this.wildcardEnvelopedListeners.add(listener);
      return () => this.wildcardEnvelopedListeners.delete(listener);
    }
    let set = this.envelopedListeners.get(event);
    if (!set) {
      set = new Set();
      this.envelopedListeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.envelopedListeners.delete(event);
    };
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
