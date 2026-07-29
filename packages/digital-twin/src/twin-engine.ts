// Pure digital-twin transition logic. `step` applies a set of transition rules
// simultaneously (all reads use the prior state); `project` repeats for N steps.

import type { Snapshot, TransitionSpec, TwinState } from './types.js';

/** Apply transition rules simultaneously, returning the next state. */
export function step(state: TwinState, rules: TransitionSpec[]): TwinState {
  const next: TwinState = { ...state };
  for (const rule of rules) {
    let value = rule.add ?? 0;
    for (const dep of rule.from ?? []) {
      value += dep.factor * (state[dep.key] ?? 0);
    }
    next[rule.key] = value;
  }
  return next;
}

/** Run `rules` for `n` steps from `initial`; returns the trajectory of states. */
export function project(initial: TwinState, rules: TransitionSpec[], n: number): TwinState[] {
  const trajectory: TwinState[] = [{ ...initial }];
  let current = initial;
  for (let i = 0; i < n; i++) {
    current = step(current, rules);
    trajectory.push({ ...current });
  }
  return trajectory;
}

/** Convenience: take a snapshot at discrete time t. */
export function snapshot(state: TwinState, t: number): Snapshot {
  return { t, state: { ...state }, ts: Date.now() };
}
