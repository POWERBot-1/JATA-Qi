// Blackboard — per-agent working memory with optional time-decay (forgetting).
// NPCs read sensors and write facts here; decision nodes consume them. This is
// the "memory" capability of §6.

import type { Blackboard as IBlackboard } from './status.js';

interface Slot { value: unknown; /** Decay rate per second (0 = never forgets). */ decay?: number; updatedAt: number }

export class Blackboard implements IBlackboard {
  private slots = new Map<string, Slot>();

  get<T = unknown>(key: string): T | undefined {
    return this.slots.get(key)?.value as T | undefined;
  }

  set<T>(key: string, value: T, decayPerSec = 0): void {
    this.slots.set(key, { value, ...(decayPerSec > 0 ? { decay: decayPerSec } : {}), updatedAt: Date.now() });
  }

  has(key: string): boolean { return this.slots.has(key); }
  delete(key: string): boolean { return this.slots.delete(key); }
  keys(): string[] { return [...this.slots.keys()]; }

  /** Apply time-based decay; values whose weight reaches zero are forgotten. */
  decayAll(dt: number): void {
    const now = Date.now();
    for (const [key, slot] of this.slots) {
      if (slot.decay === undefined) continue;
      const elapsed = (now - slot.updatedAt) / 1000;
      if (typeof slot.value === 'number') {
        const v = slot.value * Math.exp(-slot.decay * dt);
        slot.value = v;
        if (Math.abs(v) < 1e-6) this.slots.delete(key);
      } else {
        // Non-numeric facts forget after a fixed half-life count of ticks.
        if (elapsed > 1 / slot.decay) this.slots.delete(key);
      }
    }
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, s] of this.slots) out[k] = s.value;
    return out;
  }
}
