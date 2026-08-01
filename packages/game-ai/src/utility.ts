// Utility AI — scores candidate actions by weighted considerations and picks
// the highest-scoring one (a flexible alternative to behavior trees, named in
// §6 as "decision making"). Scores can be shaped by personality/emotion.

import type { AiContext } from './status.js';

/** A consideration maps the context to a 0..1 score. */
export type Consideration = (ctx: AiContext) => number;

/** A response curve shapes a raw input (0..1) into a 0..1 score. */
export type ResponseCurve = (x: number) => number;

export const curves = {
  linear: (x: number) => clamp01(x),
  quadratic: (x: number) => clamp01(x * x),
  exponential: (x: number) => clamp01(x * x * x),
  sigmoid: (x: number) => clamp01(1 / (1 + Math.exp(-10 * (x - 0.5)))),
  inverse: (x: number) => clamp01(1 - x),
  threshold: (t: number) => (x: number) => (x >= t ? 1 : 0),
};

export interface UtilityAction {
  name: string;
  /** Considerations + their relative weights. */
  considerations: Array<{ score: Consideration; weight: number; curve?: ResponseCurve }>;
  /** Executes the chosen action (returns true on completion). */
  run: (ctx: AiContext) => void;
  /** Optional bias added to the final score (personality/emotion). */
  bias?: number;
}

/** A utility-driven decider. */
export class UtilityAi {
  private actions: UtilityAction[] = [];
  private current?: UtilityAction;

  add(action: UtilityAction): this { this.actions.push(action); return this; }

  /** Evaluate all actions and pick the best; returns its name (or null). */
  decide(ctx: AiContext): UtilityAction | null {
    let best: UtilityAction | null = null;
    let bestScore = -Infinity;
    for (const a of this.actions) {
      const s = this.score(a, ctx);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }

  /** Tick: pick the best action and run it. Switches when a better one wins. */
  tick(ctx: AiContext): string | null {
    const best = this.decide(ctx);
    if (best && best !== this.current) this.current = best;
    if (this.current) {
      this.current.run(ctx);
      return this.current.name;
    }
    return null;
  }

  /** Score an action by the weighted geometric-ish mean of considerations. */
  score(action: UtilityAction, ctx: AiContext): number {
    if (action.considerations.length === 0) return action.bias ?? 0;
    let product = 1;
    let totalWeight = 0;
    for (const c of action.considerations) {
      const raw = clamp01(c.score(ctx));
      const shaped = c.curve ? clamp01(c.curve(raw)) : raw;
      // Weighted power mean contribution.
      product *= Math.pow(shaped, c.weight);
      totalWeight += c.weight;
    }
    const agg = totalWeight > 0 ? Math.pow(product, 1 / totalWeight) : 0;
    return clamp01(agg) + (action.bias ?? 0);
  }

  get currentAction(): string | null { return this.current?.name ?? null; }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
