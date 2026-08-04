// JATA Qi Digital Twin — types.
//
// A "Digital Twin Universe" is referenced across the spec (Step 31 planetary
// twins, Step 32 robotics twins, the Digital Twin Universe milestone). A twin
// mirrors a real or modeled system as numeric state that can be stepped forward
// by transition rules and projected into a trajectory.

export type TwinState = Record<string, number>;

/** A point-in-time snapshot of a twin's state. */
export interface Snapshot {
  /** Discrete time step (0-based). */
  t: number;
  state: TwinState;
  ts: number;
}

/** A registered digital twin. */
export interface Twin {
  id: string;
  type: string;
  name: string;
  state: TwinState;
  metadata?: Record<string, unknown>;
  history: Snapshot[];
  createdAt: number;
}

/**
 * A declarative transition rule. The next value of `key` is computed from the
 * CURRENT state (all rules applied simultaneously):
 *   next[key] = (add ?? 0) + sum(from.factor * state[from.key])
 */
export interface TransitionSpec {
  key: string;
  add?: number;
  from?: { key: string; factor: number }[];
}

export const DigitalTwinEvents = Object.freeze({
  TwinRegistered: 'twin.registered',
  TwinStepped: 'twin.stepped',
} as const);
