// SimulationLoop — fixed-timestep accumulator. Advances the world in discrete,
// equal-sized steps so simulation is deterministic and stable regardless of the
// (variable) wall-clock frame rate. The accumulator carries the remainder,
// which is essential for replays and lockstep multiplayer.

import type { World } from './world.js';

export interface StepResult {
  /** Number of fixed steps executed. */
  steps: number;
  /** Remaining accumulated seconds carried into the next call. */
  remainder: number;
}

export class SimulationLoop {
  private accumulator = 0;
  readonly fixedDt: number;

  constructor(private world: World, fixedDt = 1 / 60) {
    if (fixedDt <= 0) throw new Error('loop: fixedDt must be positive');
    this.fixedDt = fixedDt;
  }

  /** Remaining carried time. */
  get carried(): number { return this.accumulator; }

  /** Reset the accumulator (e.g. after a pause). */
  reset(): void { this.accumulator = 0; }

  /**
   * Advance the simulation by `elapsed` wall-clock seconds. Caps the number of
   * steps per call to avoid the "spiral of death" after a long stall.
   */
  advance(elapsed: number, maxSteps = 10): StepResult {
    if (elapsed < 0) elapsed = 0;
    this.accumulator += elapsed;
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < maxSteps) {
      this.world.step(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    // If we hit the cap, drop the backlog to avoid spiralling.
    if (steps >= maxSteps) this.accumulator = 0;
    return { steps, remainder: this.accumulator };
  }

  /** Run exactly N fixed steps. */
  stepN(n: number): void {
    for (let i = 0; i < n; i++) this.world.step(this.fixedDt);
  }
}
