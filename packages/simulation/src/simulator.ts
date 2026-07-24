// Monte-Carlo simulator: runs a scenario's output function over many randomized
// trials and aggregates the results into a probabilistic summary.

import { mulberry32, randomSeed } from './rng.js';
import { computeStats, histogram } from './statistics.js';
import { SIMULATION_CAVEAT } from './types.js';
import type { Scenario, SimulationResult } from './types.js';

/** Run a scenario and return a probabilistic result. */
export function simulate<T = number>(scenario: Scenario<T>): SimulationResult<T> {
  const trials = scenario.trials ?? 10_000;
  const seed = scenario.seed ?? randomSeed();
  const rng = mulberry32(seed);

  const samples: T[] = new Array(trials);
  for (let i = 0; i < trials; i++) {
    const ctx: Record<string, number> = {};
    for (const [name, dist] of Object.entries(scenario.inputs)) {
      ctx[name] = dist.sample(rng);
    }
    samples[i] = scenario.output(ctx);
  }

  // Statistics assume numeric outputs (the common case).
  const numeric = samples as unknown as number[];
  const stats = computeStats(numeric);
  const hist = histogram(numeric);

  let probabilities: Record<string, number> | undefined;
  if (scenario.targets && scenario.targets.length > 0) {
    probabilities = {};
    for (const target of scenario.targets) {
      let le = 0;
      for (const v of numeric) if (v <= target) le += 1;
      probabilities[String(target)] = le / trials;
    }
  }

  const result: SimulationResult<T> = {
    scenario: scenario.name,
    ...(scenario.description ? { description: scenario.description } : {}),
    trials,
    seed,
    stats,
    samples: samples.slice(0, 1000),
    histogram: hist,
    ...(probabilities ? { probabilities } : {}),
    caveat: SIMULATION_CAVEAT,
  };
  return result;
}
