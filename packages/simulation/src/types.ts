// JATA Qi Simulation — types.
//
// The Simulation Engine (spec Step 3 #10, Step 11 SIL #3) runs scenario models
// over many randomized trials and reports PROBABILISTIC outputs. The spec is
// emphatic that "simulation outputs should be clearly identified as modeled
// results rather than certain predictions" — every result carries this warning.

/** A random distribution that can be sampled from a uniform [0,1) RNG. */
export interface Distribution {
  readonly kind: string;
  readonly params: Record<string, number | number[]>;
  sample(rng: () => number): number;
}

/** A scenario model: named random inputs and a pure output function over them. */
export interface Scenario<T = number> {
  readonly name: string;
  /** Number of Monte-Carlo trials (default 10000). */
  readonly trials?: number;
  /** Seed for reproducibility (default: time-based). */
  readonly seed?: number;
  /** Named random variables consumed by `output`. */
  readonly inputs: Record<string, Distribution>;
  /** Pure function: given sampled inputs, produce a trial result. */
  readonly output: (ctx: Record<string, number>) => T;
  /** Human description of what is being modeled. */
  readonly description?: string;
  /** Optional thresholds; the result reports P(outcome <= target) for each. */
  readonly targets?: number[];
}

export interface Stats {
  count: number;
  mean: number;
  stdev: number;
  min: number;
  max: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
}

export interface SimulationResult<T = number> {
  readonly scenario: string;
  readonly description?: string;
  readonly trials: number;
  readonly seed: number;
  readonly stats: Stats;
  /** Trial outputs (capped to keep payloads small). */
  readonly samples: T[];
  /** A coarse histogram of the sampled outputs. */
  readonly histogram: { bucket: string; count: number }[];
  /** Probability the modeled outcome is <= a threshold, if requested. */
  readonly probabilities?: Record<string, number>;
  /**
   * Explicit caveat — simulations are modeled scenarios, not predictions of
   * certain future events. Always included per the specification.
   */
  readonly caveat: string;
}

export const SimulationEvents = Object.freeze({
  SimulationCompleted: 'simulation.completed',
} as const);

export const SIMULATION_CAVEAT =
  'Modeled scenario — probabilistic output, not a prediction of a certain outcome.';
