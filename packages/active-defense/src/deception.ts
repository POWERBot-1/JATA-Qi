// Deception environment — honeytokens and decoy services that lure and
// expose attackers. Any touch generates a critical finding via the callback.

import { randomUUID } from 'node:crypto';
import type { DecoyService, DeceptionTouch, Honeytoken } from './types.js';

export interface TouchHandler {
  (touch: DeceptionTouch): void;
}

/** Deception engine: honeytokens (one-time, self-rotating) + decoy services. */
export class DeceptionEngine {
  private tokens = new Map<string, Honeytoken>();
  private decoys = new Map<string, DecoyService>();
  private touches: DeceptionTouch[] = [];
  private onTouch: TouchHandler;

  constructor(onTouch: TouchHandler = () => undefined) {
    this.onTouch = onTouch;
  }

  createHoneytoken(input: { label: string; value: string; placement: string; oneTime?: boolean }): Honeytoken {
    if (!input.label || !input.value || !input.placement) throw new Error('label, value, and placement are required');
    const token: Honeytoken = {
      id: randomUUID(), label: input.label, value: input.value,
      placement: input.placement, oneTime: input.oneTime ?? true,
      createdAt: Date.now(), touched: false,
    };
    this.tokens.set(token.id, token);
    return token;
  }

  listHoneytokens(): Honeytoken[] {
    return [...this.tokens.values()];
  }

  /**
   * Check a value against every active honeytoken. On match: records a touch,
   * fires the handler (→ critical finding + risk spike), and rotates the
   * token (one-time use).
   */
  checkHoneytoken(value: string, source?: string, context?: Record<string, unknown>): Honeytoken | undefined {
    for (const token of this.tokens.values()) {
      if (token.touched) continue;
      if (token.value === value) {
        token.touched = true;
        const touch: DeceptionTouch = {
          id: randomUUID(), kind: 'honeytoken', target: token.label,
          ...(source ? { source } : {}),
          ...(context ? { context } : {}),
          ts: Date.now(),
        };
        this.touches.push(touch);
        if (token.oneTime) {
          // Rotate: invalidate the old value, mint a fresh one.
          token.value = `${token.value}-rotated-${randomUUID().slice(0, 8)}`;
          token.touched = false;
        }
        this.onTouch(touch);
        return token;
      }
    }
    return undefined;
  }

  registerDecoy(input: { name: string; kind: DecoyService['kind']; endpoint?: string }): DecoyService {
    if (!input.name) throw new Error('name is required');
    const decoy: DecoyService = {
      id: randomUUID(), name: input.name, kind: input.kind,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      createdAt: Date.now(),
    };
    this.decoys.set(decoy.id, decoy);
    return decoy;
  }

  listDecoys(): DecoyService[] {
    return [...this.decoys.values()];
  }

  /**
   * Simulate an attacker probing a decoy (e.g. a decoy API endpoint received
   * a request). Records a touch + fires the handler.
   */
  probeDecoy(name: string, source?: string, context?: Record<string, unknown>): DecoyService {
    const decoy = [...this.decoys.values()].find((d) => d.name === name);
    if (!decoy) throw new Error(`unknown decoy ${name}`);
    const touch: DeceptionTouch = {
      id: randomUUID(), kind: 'decoy', target: decoy.name,
      ...(source ? { source } : {}),
      ...(context ? { context } : {}),
      ts: Date.now(),
    };
    this.touches.push(touch);
    this.onTouch(touch);
    return decoy;
  }

  listTouches(): DeceptionTouch[] {
    return [...this.touches].reverse();
  }
}
