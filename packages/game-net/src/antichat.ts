// Anti-cheat — input validators that reject impossible or abusive client input
// before the authoritative server applies it (§9 "anti-cheat"). Validators are
// composable; the server runs them on every inbound input.

export interface ValidationContext {
  peer: string;
  now: number;
  /** Per-peer rolling state (e.g. last input time, position). */
  state: Map<string, unknown>;
}

export interface ValidationResult { ok: boolean; reason?: string; }

export interface InputValidator {
  name: string;
  validate(payload: unknown, ctx: ValidationContext): ValidationResult;
}

/** Rejects inputs arriving faster than the configured rate. */
export class RateLimitValidator implements InputValidator {
  readonly name = 'rate-limit';
  private lastAt = new Map<string, number>();
  constructor(private minIntervalMs = 8) {} // ~120 inputs/sec cap
  validate(payload: unknown, ctx: ValidationContext): ValidationResult {
    const last = this.lastAt.get(ctx.peer) ?? 0;
    if (ctx.now - last < this.minIntervalMs) return { ok: false, reason: 'input rate exceeded' };
    this.lastAt.set(ctx.peer, ctx.now);
    return { ok: true };
  }
}

/** Bounds a numeric movement vector's magnitude (speed-hack guard). */
export class MagnitudeValidator implements InputValidator {
  readonly name = 'magnitude';
  constructor(private field: string, private maxMagnitude: number) {}
  validate(payload: unknown): ValidationResult {
    if (!payload || typeof payload !== 'object') return { ok: true };
    const v = (payload as Record<string, unknown>)[this.field];
    if (!Array.isArray(v)) return { ok: true };
    const mag = Math.hypot(...v.map(Number));
    return mag <= this.maxMagnitude ? { ok: true } : { ok: false, reason: `magnitude ${mag.toFixed(2)} exceeds ${this.maxMagnitude}` };
  }
}

/** Rejects malformed payloads. */
export class ShapeValidator implements InputValidator {
  readonly name = 'shape';
  constructor(private check: (payload: unknown) => boolean, private reason: string) {}
  validate(payload: unknown): ValidationResult {
    return this.check(payload) ? { ok: true } : { ok: false, reason: this.reason };
  }
}

/** Runs a chain of validators; fails on the first rejection. */
export class AntiCheat implements InputValidator {
  readonly name = 'anti-cheat';
  private validators: InputValidator[] = [];
  private blocked = 0;
  add(v: InputValidator): this { this.validators.push(v); return this; }
  validate(payload: unknown, ctx: ValidationContext): ValidationResult {
    for (const v of this.validators) {
      const r = v.validate(payload, ctx);
      if (!r.ok) { this.blocked++; return r; }
    }
    return { ok: true };
  }
  get blockedCount(): number { return this.blocked; }
}
