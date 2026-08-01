// Finite State Machine — states + guarded transitions. Simple, readable, and a
// good fit for many NPC behaviors (idle → patrol → chase → attack → flee).

import type { AiContext } from './status.js';

export type FsmGuard = (ctx: AiContext) => boolean;
export type FsmAction = (ctx: AiContext) => void;

export interface FsmTransition {
  to: string;
  guard?: FsmGuard;
  onTransition?: FsmAction;
}

export class FsmState {
  readonly transitions: FsmTransition[] = [];
  constructor(public readonly name: string, public onEnter?: FsmAction, public onUpdate?: FsmAction, public onExit?: FsmAction) {}
  to(state: string, guard?: FsmGuard, onTransition?: FsmAction): this {
    this.transitions.push({ to: state, guard, onTransition });
    return this;
  }
}

/** A finite state machine driver. */
export class FiniteStateMachine {
  private states = new Map<string, FsmState>();
  private current: string;

  constructor(initial: string) {
    this.current = initial;
    this.add(new FsmState(initial));
  }

  add(state: FsmState): this { this.states.set(state.name, state); return this; }
  getState(name: string): FsmState | undefined { return this.states.get(name); }
  get currentName(): string { return this.current; }

  /** Force a state change (ignores guards). */
  force(name: string, ctx: AiContext): void {
    if (!this.states.has(name) || name === this.current) return;
    this.exitCurrent(ctx);
    this.current = name;
    this.enterCurrent(ctx);
  }

  /** Tick the current state and evaluate transitions. */
  tick(ctx: AiContext): string {
    const state = this.states.get(this.current);
    if (!state) return this.current;
    state.onUpdate?.(ctx);
    for (const t of state.transitions) {
      if (t.guard && !t.guard(ctx)) continue;
      if (!this.states.has(t.to)) continue;
      this.exitCurrent(ctx);
      this.current = t.to;
      t.onTransition?.(ctx);
      this.enterCurrent(ctx);
      break;
    }
    return this.current;
  }

  private enterCurrent(ctx: AiContext): void { this.states.get(this.current)?.onEnter?.(ctx); }
  private exitCurrent(ctx: AiContext): void { this.states.get(this.current)?.onExit?.(ctx); }
}
